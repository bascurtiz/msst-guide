#!/usr/bin/env bash
#
# Stand up the VM that runs the guide's CMS — all of step 1 in
# admin/MOVING-THE-CMS.md, as a command rather than a checklist.
#
# The guide's words live in InStatic: one Bun server, a SQLite database and a
# pile of files on its own disk. This script builds the host for it, and nothing
# else — it does not touch the database, the site bundle or the relay, because
# the runbook's whole point is that those happen in order, on a host that already
# works. It is written for the move off Railway onto Google's always-free
# e2-micro, but nothing in it is Google-specific except the notes at the end.
#
# On the box itself:
#
#     sudo tools/provision-vm.sh --origin https://<ip>.sslip.io \
#                                --image ghcr.io/corebunch/instatic:0.0.20
#
# Or from a laptop with gcloud authenticated, which folds the VM creation in and
# makes the whole step one command. The script reads its arguments from the
# instance metadata when it is handed over as a startup script:
#
#     gcloud compute instances create msst-cms \
#       --zone=us-central1-a --machine-type=e2-micro \
#       --image-family=debian-12 --image-project=debian-cloud \
#       --boot-disk-type=pd-standard --boot-disk-size=30GB \
#       --tags=http-server,https-server --address=<static-ip-name> \
#       --metadata-from-file=startup-script=tools/provision-vm.sh \
#       --metadata=origin=https://<ip>.sslip.io,image=ghcr.io/corebunch/instatic:0.0.20
#
# What it does, in this order:
#
#   1. A 2 GB swap file, made persistent in /etc/fstab. The box has 1 GB of RAM
#      and the CMS measures ~400 MB; publishing renders every page at once, and
#      swap is what stops that spike being an OOM kill of the site.
#   2. Docker, from the vendor's own install script.
#   3. A host firewall: SSH, 80 and 443, everything else closed.
#   4. The volume, the Compose file, the Caddyfile and .env (mode 600).
#   5. The CMS and Caddy, then it waits for the CMS to answer /health.
#   6. A Let's Encrypt certificate for the origin, proved by fetching the live
#      site over TLS.
#   7. A nightly backup: a consistent SQLite snapshot plus an archive of the
#      volume, run by a systemd timer, and run once now so the mechanism is
#      proved rather than assumed.
#
# Flags:
#
#     --origin <url>     the CMS's public address, https:// and no path. Required
#                        (or an `origin` metadata attribute). It becomes both the
#                        Caddy site address and PUBLIC_ORIGIN, which have to
#                        match exactly or the login form is rejected with
#                        "Forbidden: invalid origin".
#     --image <ref>      ghcr.io/corebunch/instatic:<version>. Never `latest`:
#                        the CMS is pre-1.0 and a surprise major change is not a
#                        way to spend a morning.
#     --key-file <path>  file holding the value of INSTATIC_SECRET_KEY. Falls back
#                        to $INSTATIC_SECRET_KEY, then to the
#                        `instatic-secret-key` metadata attribute.
#     --email <address>  ACME account address for Caddy. Optional.
#     --dir <path>       where the Compose project lives. Default /opt/msst-cms.
#     --port <n>         container port. Default 3001.
#     --backups <path>   backup directory. Default /var/backups/msst-cms.
#     --keep <days>      how many days of backups to keep. Default 14.
#     --ssh-port <n>     the port SSH listens on. Default 22. Get this wrong and
#                        the firewall locks you out of the box.
#     --dry-run <dir>    write the configuration into <dir> and print what would
#                        happen, touching nothing. This is what the tests use, so
#                        what it shows cannot drift from what the script does.
#     --force-env        rewrite .env even though it exists (see below).
#     --check            verify an existing install instead of installing one.
#
# It is idempotent, and it is meant to be: a startup script runs again on every
# reboot. Two rules follow from that.
#
#   - **An existing .env is preserved**, because that file holds the secret key,
#     and rewriting it with a different key is the one mistake here that cannot
#     be undone: every encrypted value — AI provider keys, TOTP seeds — becomes
#     unreadable. Changing the origin needs --force-env and a deliberate decision.
#   - **Everything else is re-rendered from the flags**, so `--image <new tag>`
#     re-run is the upgrade path.
#
# The secret key is required only when .env is being written. On a re-run it
# comes from the file that already has it, which is why the key can safely be
# taken back out of the instance metadata afterwards (see the summary at the end).

set -euo pipefail

ORIGIN=""
IMAGE=""
KEY=""
KEY_FILE=""
EMAIL=""
DIR="/opt/msst-cms"
PORT="3001"
BACKUP_DIR="/var/backups/msst-cms"
KEEP_DAYS="14"
SSH_PORT="22"
DRY_RUN=""
FORCE_ENV="0"
CHECK="0"

ARGS=("$@")

if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  B=""; G=""; Y=""; R=""; D=""; N=""
fi

step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*" >&2; }
note() { printf '    %s%s%s\n' "$D" "$*" "$N"; }
die()  { printf '\n  %s✗ %s%s\n\n' "$R" "$*" "$N" >&2; exit 1; }

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

# ------------------------------------------------------------------- arguments ---

while [ $# -gt 0 ]; do
  case "$1" in
    --origin)    ORIGIN="${2:-}"; shift 2 ;;
    --image)     IMAGE="${2:-}"; shift 2 ;;
    --key-file)  KEY_FILE="${2:-}"; shift 2 ;;
    --email)     EMAIL="${2:-}"; shift 2 ;;
    --dir)       DIR="${2:-}"; shift 2 ;;
    --port)      PORT="${2:-}"; shift 2 ;;
    --backups)   BACKUP_DIR="${2:-}"; shift 2 ;;
    --keep)      KEEP_DAYS="${2:-}"; shift 2 ;;
    --ssh-port)  SSH_PORT="${2:-}"; shift 2 ;;
    --dry-run)   DRY_RUN="${2:-}"; shift 2 ;;
    --force-env) FORCE_ENV="1"; shift ;;
    --check)     CHECK="1"; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           die "unknown argument: $1 (try --help)" ;;
  esac
done

# GCP's metadata service, when this arrived as a startup script rather than an
# argument list. Absent everywhere else, which is why every read is optional.
meta() {
  curl -fsS --max-time 5 -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || true
}

# --- validation ---
#
# Every value below is substituted into a file this script writes, so each one is
# held to a shape that cannot carry a newline, a quote, a `$` or a space. The
# secret key is the exception and never goes through a template — see write_env.

validate() {
  if ! printf '%s' "$ORIGIN" | grep -Eq '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'; then
    die "--origin must be https:// and a bare hostname, no port, no path (got '${ORIGIN:-<empty>}').
    InStatic compares it against the browser's origin on every login, so it has to
    be exactly the address the editor is reached on — https://<ip>.sslip.io for a
    VM with no domain of its own."
  fi

  if ! printf '%s' "$IMAGE" | grep -Eq '^ghcr\.io/corebunch/instatic:[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._-]+)?$'; then
    die "--image must be a pinned release, e.g. ghcr.io/corebunch/instatic:0.0.20 (got '${IMAGE:-<empty>}').
    \`latest\` is refused on purpose: the CMS is pre-1.0 and moving, and this host
    is not where you want to find out what shipped."
  fi

  printf '%s' "$PORT"      | grep -Eq '^[0-9]{2,5}$' || die "--port must be a number (got '$PORT')"
  printf '%s' "$KEEP_DAYS" | grep -Eq '^[0-9]{1,4}$' || die "--keep must be a number of days (got '$KEEP_DAYS')"
  printf '%s' "$SSH_PORT"  | grep -Eq '^[0-9]{2,5}$' || die "--ssh-port must be a number (got '$SSH_PORT')"
  [ -z "$EMAIL" ] || printf '%s' "$EMAIL" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' \
    || die "--email does not look like an address (got '$EMAIL')"
  printf '%s' "$DIR"        | grep -Eq '^/[A-Za-z0-9._/-]+$' || die "--dir must be an absolute path with no spaces"
  printf '%s' "$BACKUP_DIR" | grep -Eq '^/[A-Za-z0-9._/-]+$' || die "--backups must be an absolute path with no spaces"
}

# --- the arguments, from wherever they are available ---

DOMAIN=""
COMPOSE_FILE=""
VOLUME_NAME="msst-cms_storage"

resolve() {
  [ -n "$ORIGIN" ] || ORIGIN="$(meta origin)"
  [ -n "$IMAGE" ]  || IMAGE="$(meta image)"
  [ -n "$EMAIL" ]  || EMAIL="$(meta email)"
  if [ -z "$KEY" ] && [ -z "$KEY_FILE" ]; then
    KEY="$(meta instatic-secret-key)"
    [ -n "$KEY" ] || KEY="${INSTATIC_SECRET_KEY:-}"
  fi

  [ -n "$ORIGIN" ] || die "no origin.
    Pass --origin https://<address>, or set it as the 'origin' instance metadata
    attribute. The runbook's step 1 says more about choosing it."
  [ -n "$IMAGE" ] || die "no image.
    Pass --image ghcr.io/corebunch/instatic:<version> — the tag the Railway
    service is running, pinned (step 0 of the runbook)."

  ORIGIN="$(printf '%s' "$ORIGIN" | tr '[:upper:]' '[:lower:]')"
  DOMAIN="${ORIGIN#https://}"
  COMPOSE_FILE="$DIR/docker-compose.yml"
  validate
}

# -------------------------------------------------------------------- templates ---
#
# Rendering is a separate step from installing, so `--dry-run` writes exactly the
# files the real run would write. That is the point of the flag: what it shows is
# not a description of the script, it is the script's own output.

render_compose() {
  cat > "$1/docker-compose.yml" <<EOF
# Rendered by tools/provision-vm.sh — edits here are overwritten on the next run.
#
# Two containers and one volume. The volume is the site: the SQLite database at
# data/cms.db and everything under uploads/ — media, fonts, plugin packs, and the
# published HTML the relay serves. Its name is fixed by \`name:\` below so that
# msst-cms_storage is stable for the backup script, and anyone restoring a copy
# of the old Railway volume knows where to put it.
name: msst-cms

services:
  app:
    image: $IMAGE
    restart: unless-stopped
    env_file: [.env]
    volumes:
      - storage:/app/storage
    # Loopback only. Docker's published ports go in through their own iptables
    # rules, which the host firewall does not filter — so publishing this on
    # 0.0.0.0 would put the editor on the internet in plain HTTP, behind Caddy's
    # back and around its TLS. Caddy reaches it over the compose network instead.
    ports:
      - "127.0.0.1:$PORT:$PORT"
    healthcheck:
      # curl is not guaranteed to be in the image; bun is what it certainly has.
      # Caddy waits for this, so a first boot does not serve 502s while the CMS
      # runs its migrations.
      test: ["CMD", "bun", "-e", "const r = await fetch('http://127.0.0.1:$PORT/health'); process.exit(r.ok ? 0 : 1)"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 60s

  caddy:
    image: caddy:2
    restart: unless-stopped
    depends_on:
      app:
        condition: service_healthy
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  storage:
  caddy_data:
  caddy_config:
EOF
}

render_caddyfile() {
  if [ -n "$EMAIL" ]; then
    cat > "$1/Caddyfile" <<EOF
# Rendered by tools/provision-vm.sh — edits here are overwritten on the next run.

{
	email $EMAIL
}

$DOMAIN {
	encode zstd gzip
	reverse_proxy app:$PORT
}
EOF
  else
    cat > "$1/Caddyfile" <<EOF
# Rendered by tools/provision-vm.sh — edits here are overwritten on the next run.
#
# Caddy gets and renews a Let's Encrypt certificate for the name below, and hands
# plain HTTP to the app container on the compose network. That is why
# PUBLIC_ORIGIN in .env names the same host: InStatic's CSRF check compares
# against it, and a mismatch rejects the login form with
# "Forbidden: invalid origin".

$DOMAIN {
	encode zstd gzip
	reverse_proxy app:$PORT
}
EOF
  fi
}

# Not a heredoc: the key goes in with printf, because a heredoc would expand `$`
# and backticks in it, and a secret is not something to discover is broken later.
write_env() {
  local f="$1/.env"
  (
    umask 077
    printf '# Rendered by tools/provision-vm.sh — but not overwritten on a re-run,\n'
    printf '# because INSTATIC_SECRET_KEY lives here and cannot be rotated safely.\n'
    printf '# See admin/MOVING-THE-CMS.md.\n'
    printf 'PORT=%s\n' "$PORT"
    printf 'DATABASE_URL=sqlite:/app/storage/data/cms.db\n'
    printf 'UPLOADS_DIR=/app/storage/uploads\n'
    printf 'STATIC_DIR=/app/dist\n'
    printf 'PUBLIC_ORIGIN=%s\n' "$ORIGIN"
    # Client IPs in audit logs and rate-limit keys come from the proxy, and only
    # the proxy is trusted to set them. It is the compose network, whose subnet
    # Docker picks at creation, so it can only be filled in after the first
    # `up` — `--check` prints it. Empty means the CMS attributes every request
    # to Caddy, which is a smaller problem than trusting a header from anywhere.
    printf '# TRUSTED_PROXY_CIDRS=%s\n' "<--check prints the compose subnet>"
    printf 'INSTATIC_SECRET_KEY=%s\n' "$KEY"
  ) > "$f"
  chmod 600 "$f"
}

render_backup_script() {
  local f="$1/backup.sh"
  {
    printf '#!/usr/bin/env bash\n'
    printf '# Installed by tools/provision-vm.sh as /usr/local/sbin/msst-cms-backup\n'
    printf '# and run nightly by msst-cms-backup.timer. This is the site: the database\n'
    printf '# and everything in the volume. The published HTML is derived, but it is\n'
    printf '# archived anyway — it is what the relay serves while the CMS is down.\n\n'
    printf 'COMPOSE_FILE=%q\n' "$COMPOSE_FILE"
    printf 'DEST=%q\n' "$BACKUP_DIR"
    printf 'KEEP_DAYS=%s\n' "$KEEP_DAYS"
    printf 'VOLUME=%q\n' "$VOLUME_NAME"
  } > "$f"

  cat >> "$f" <<'EOF'

set -euo pipefail

# One backup at a time. A reboot that fires Persistent=true, or a hand-run that
# overlaps the timer, waits its turn instead of racing the first one.
exec 9>/run/lock/msst-cms-backup.lock
if ! flock -n 9; then
  echo "a backup is already running — nothing to do"
  exit 0
fi

DB=/app/storage/data/cms.db
SNAPSHOT=/app/storage/data/snapshot.db
STAMP=$(date +%F)

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

install -d -m 750 "$DEST"

# Space before anything else: a full disk turns a backup into a failure at 03:30
# that nobody is watching, and it takes the CMS down with it.
free_kb=$(df -Pk "$DEST" | awk 'NR==2 {print $4}')
if [ "$free_kb" -lt 1048576 ]; then
  echo "WARNING: only $((free_kb / 1024)) MB free under $DEST"
fi

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  echo "volume $VOLUME does not exist — is the Compose project still here?"
  exit 1
fi

# A run that died mid-snapshot leaves one inside the volume, where it would be
# archived with everything else.
compose exec -T app rm -f "$SNAPSHOT" 2>/dev/null || true

# 1. The database, copied consistently while the CMS keeps serving. VACUUM INTO
#    goes through SQLite's own consistency machinery — no locking, no downtime —
#    which is what makes this safe from a timer.
if compose exec -T app test -f "$DB"; then
  compose exec -T app bun -e "import { Database } from \"bun:sqlite\"; const src = new Database(\"$DB\", { readonly: true }); src.exec(\"VACUUM INTO '$SNAPSHOT'\");"
  compose cp "app:$SNAPSHOT" "$DEST/db-$STAMP.sqlite"
  compose exec -T app rm -f "$SNAPSHOT"
  # A snapshot that is nearly empty is a copy that did not happen. Failing here
  # is what keeps the timer's silence meaning something.
  size=$(stat -c %s "$DEST/db-$STAMP.sqlite")
  if [ "$size" -lt 4096 ]; then
    echo "snapshot $DEST/db-$STAMP.sqlite is only $size bytes — that is not a backup"
    exit 1
  fi
  echo "database: $DEST/db-$STAMP.sqlite ($((size / 1024)) KB)"
else
  echo "no database yet at $DB — nothing to back up (expected before the import)"
fi

# 2. The rest of the volume. The whole uploads/ tree, so a restore is a tar into
#    an empty volume rather than a guess about which paths mattered. A volume that
#    has not been uploaded to yet has no uploads/ at all — that is a fresh host,
#    not a failed backup, and tar exits 1 on it, which would red the timer on a
#    healthy box and leave an empty archive behind for a restore to trip over.
docker run --rm -v "$VOLUME":/src:ro -v "$DEST":/backup alpine \
  sh -c 'if [ -d /src/uploads ]; then tar czf "/backup/uploads-$1.tgz" -C /src uploads; else echo "no uploads/ directory yet — nothing to archive"; fi' _ "$STAMP"
if [ -f "$DEST/uploads-$STAMP.tgz" ]; then
  echo "uploads: $DEST/uploads-$STAMP.tgz ($(du -k "$DEST/uploads-$STAMP.tgz" | awk '{print $1}') KB)"
fi

# 3. Retention. This is a 30 GB disk shared with Docker images and the volume
#    itself, not a backup appliance.
find "$DEST" -type f -name 'db-*.sqlite' -mtime +"$KEEP_DAYS" -delete
find "$DEST" -type f -name 'uploads-*.tgz' -mtime +"$KEEP_DAYS" -delete
echo "kept $(find "$DEST" -type f | wc -l) files, $(du -sh "$DEST" | awk '{print $1}') total"
EOF

  chmod 750 "$f"
}

render_units() {
  cat > "$1/msst-cms-backup.service" <<'EOF'
[Unit]
Description=Back up the guide's CMS (SQLite snapshot and uploads)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/msst-cms-backup
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
EOF

  cat > "$1/msst-cms-backup.timer" <<'EOF'
[Unit]
Description=Nightly backup of the guide's CMS

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=20m
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

render_all() {
  mkdir -p "$1"
  # Not `install -d`: a dry run is the one path that may be run somewhere other
  # than a Linux box, and it should not fail over a file mode it is not setting.
  chmod 750 "$1" 2>/dev/null || true
  render_compose "$1"
  render_caddyfile "$1"
  render_backup_script "$1"
  render_units "$1"
  # The key is deliberately absent from a dry run: it is a preview, and a preview
  # exported to a ticket or a log should not carry the master key for every
  # encrypted value on the site.
  if [ -n "$DRY_RUN" ]; then
    {
      printf '# Rendered by tools/provision-vm.sh --dry-run. The real run writes\n'
      printf '# INSTATIC_SECRET_KEY here too, with the file in mode 600. It is left\n'
      printf '# out of a dry run on purpose.\n'
      printf 'PORT=%s\n' "$PORT"
      printf 'DATABASE_URL=sqlite:/app/storage/data/cms.db\n'
      printf 'UPLOADS_DIR=/app/storage/uploads\n'
      printf 'STATIC_DIR=/app/dist\n'
      printf 'PUBLIC_ORIGIN=%s\n' "$ORIGIN"
      printf 'INSTATIC_SECRET_KEY=<not written by a dry run>\n'
    } > "$1/.env"
  fi
}

# --------------------------------------------------------------------- dry run ---

dry_run() {
  resolve
  local dir="$DRY_RUN"
  [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null || true)" ] \
    && die "--dry-run wants an empty directory; $dir is not empty"
  render_all "$dir"

  step "Rendered into $dir — nothing on this machine was touched"
  ok "docker-compose.yml  the CMS and Caddy, one volume at /app/storage"
  ok "Caddyfile           $DOMAIN, TLS by Let's Encrypt"
  ok ".env                PUBLIC_ORIGIN=$ORIGIN, secret key not written"
  ok "backup.sh           installs as /usr/local/sbin/msst-cms-backup"
  ok "msst-cms-backup.{service,timer}  nightly at 03:30, ${KEEP_DAYS}-day retention"

  step "A real run would then, in this order"
  note "1. make a ${SWAP_SIZE} swap file and keep it in /etc/fstab"
  note "2. install Docker and enable the daemon"
  note "3. open $SSH_PORT, 80 and 443, and close everything else"
  note "4. create $DIR and ./storage, chowned to the image's own user"
  note "5. write the four files above, .env in mode 600"
  note "6. docker compose up -d, and wait for the CMS to answer /health"
  note "7. fetch $ORIGIN/health over TLS, which proves the certificate"
  note "8. install the backup script and timer, and run the backup once now"

  step "For the record, the metadata form of the same run"
  note "gcloud compute instances create msst-cms \\"
  note "  --zone=us-central1-a --machine-type=e2-micro \\"
  note "  --image-family=debian-12 --image-project=debian-cloud \\"
  note "  --boot-disk-type=pd-standard --boot-disk-size=30GB \\"
  note "  --tags=http-server,https-server --address=<static-ip-name> \\"
  note "  --metadata-from-file=startup-script=tools/provision-vm.sh \\"
  note "  --metadata=origin=$ORIGIN,image=$IMAGE"
  printf '\n'
}

# ----------------------------------------------------------------------- checks ---

FAILURES=0
check_ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
check_bad()  { printf '  %s✗%s %s\n' "$R" "$N" "$*" >&2; FAILURES=$((FAILURES + 1)); }
check_warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }

envval() { { grep -m1 -E "^$1=" "$DIR/.env" 2>/dev/null || true; } | cut -d= -f2-; }

run_checks() {
  [ -f "$DIR/.env" ] || die "no .env in $DIR — nothing installed here yet. Run without --check to install."
  [ -n "$ORIGIN" ] || ORIGIN="$(envval PUBLIC_ORIGIN)"
  DOMAIN="${ORIGIN#https://}"
  PORT="$(envval PORT)"; PORT="${PORT:-3001}"
  COMPOSE_FILE="$DIR/docker-compose.yml"

  step "Host"
  if have swapon && swapon --show=NAME --noheadings | grep -qx "$SWAP_FILE"; then
    check_ok "swap is on: $(swapon --show=NAME,SIZE --noheadings | tr -s ' ')"
  else
    check_bad "swap is not active — publishing can OOM-kill the CMS on 1 GB of RAM"
  fi
  if grep -q "^$SWAP_FILE " /etc/fstab; then
    check_ok "swap survives a reboot (/etc/fstab)"
  else
    check_bad "$SWAP_FILE is not in /etc/fstab, so the next reboot has no swap"
  fi
  if systemctl is-active --quiet docker; then
    check_ok "docker is running"
  else
    check_bad "docker is not running"
  fi
  if systemctl is-enabled --quiet docker; then
    check_ok "docker starts at boot"
  else
    check_bad "docker is not enabled at boot"
  fi
  if have ufw; then
    if ufw status | grep -q '^Status: active'; then
      check_ok "host firewall is active: $(ufw status | grep -oE '^[0-9]+(/tcp)? +ALLOW' | tr '\n' ' ')"
    else
      check_bad "ufw is installed but inactive"
    fi
  else
    check_warn "ufw is not installed — only the cloud firewall is guarding this host"
  fi
  note "the VPC firewall is the one that actually admits traffic; Docker's published"
  note "ports bypass ufw, so check 80/443 are open at the network layer too."

  step "Configuration"
  for f in docker-compose.yml Caddyfile .env; do
    [ -f "$DIR/$f" ] && check_ok "$f is present" || check_bad "$f is missing"
  done
  local mode; mode="$(stat -c %a "$DIR/.env" 2>/dev/null || echo '?')"
  [ "$mode" = "600" ] && check_ok ".env is mode 600" || check_bad ".env is mode $mode, not 600 — it holds the secret key"
  if [ "$(envval PUBLIC_ORIGIN)" = "$ORIGIN" ]; then
    check_ok "PUBLIC_ORIGIN matches the served host: $ORIGIN"
  else
    check_bad "PUBLIC_ORIGIN is '$(envval PUBLIC_ORIGIN)' but the origin is '$ORIGIN' — logins will fail with 'Forbidden: invalid origin'"
  fi
  if grep -q "^$DOMAIN {" "$DIR/Caddyfile"; then
    check_ok "Caddy serves $DOMAIN"
  else
    check_bad "Caddy does not mention $DOMAIN — TLS and the proxy are pointed elsewhere"
  fi

  step "The CMS"
  if docker compose -f "$COMPOSE_FILE" ps --status running --format '{{.Service}}' 2>/dev/null | grep -qx app; then
    check_ok "the app container is running"
  else
    check_bad "the app container is not running (docker compose -f $COMPOSE_FILE logs app)"
  fi
  local health
  health="$(curl -fsS --max-time 10 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
  if printf '%s' "$health" | grep -q '"status":"ok"'; then
    check_ok "the CMS answers /health: $health"
  else
    check_bad "no healthy answer from http://127.0.0.1:$PORT/health (got '${health:-nothing}')"
  fi
  if docker compose -f "$COMPOSE_FILE" exec -T app sh -c 'touch /app/storage/.write-test && rm /app/storage/.write-test' 2>/dev/null; then
    check_ok "the CMS can write its own volume"
  else
    check_bad "the CMS cannot write /app/storage — a restored-as-root volume does this; see step 2 of the runbook"
  fi

  step "TLS, from outside"
  local live
  live="$(curl -fsS --max-time 15 "$ORIGIN/health" 2>/dev/null || true)"
  if printf '%s' "$live" | grep -q '"status":"ok"'; then
    check_ok "$ORIGIN reaches the CMS over TLS"
    if have openssl; then
      local cert; cert="$(echo | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null \
        | openssl x509 -noout -issuer -enddate 2>/dev/null | tr '\n' ' ' || true)"
      [ -n "$cert" ] && note "${cert#issuer=}"
    fi
  else
    check_bad "$ORIGIN did not answer — DNS, the VPC firewall on 80/443, or a certificate that has not been issued yet"
    note "docker compose -f $COMPOSE_FILE logs caddy"
  fi
  local admin
  admin="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$ORIGIN/admin" 2>/dev/null || true)"
  case "$admin" in
    200|302|303|401) check_ok "/admin answers $admin — there is an editor to sign in to" ;;
    *) check_bad "/admin answered '${admin:-nothing}'" ;;
  esac

  step "Backups"
  if [ -x /usr/local/sbin/msst-cms-backup ]; then
    check_ok "the backup script is installed"
  else
    check_bad "/usr/local/sbin/msst-cms-backup is missing"
  fi
  if systemctl is-enabled --quiet msst-cms-backup.timer 2>/dev/null; then
    check_ok "the timer is enabled: $(systemctl list-timers msst-cms-backup.timer --no-pager 2>/dev/null | sed -n 2p | tr -s ' ' | cut -d' ' -f2-4)"
  else
    check_bad "msst-cms-backup.timer is not enabled"
  fi
  if [ -d "$BACKUP_DIR" ] && [ -n "$(find "$BACKUP_DIR" -type f -print -quit 2>/dev/null)" ]; then
    check_ok "$(find "$BACKUP_DIR" -type f | wc -l) backup files, newest $(find "$BACKUP_DIR" -type f -printf '%TY-%Tm-%Td %f\n' | sort | tail -1)"
  else
    check_warn "no backups in $BACKUP_DIR yet"
  fi
  note "these live on the same 30 GB disk as the database: they cover a bad edit or a"
  note "corrupt file, not the loss of the disk. An off-box copy is still owed."

  step "Anything else"
  local subnet
  subnet="$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' msst-cms_default 2>/dev/null || true)"
  if [ -n "$subnet" ]; then
    note "TRUSTED_PROXY_CIDRS=$subnet would give the CMS real client IPs in audit"
    note "logs and rate-limit keys (Caddy is the proxy). Uncomment it in $DIR/.env"
    note "and run: docker compose -f $COMPOSE_FILE up -d app"
  fi

  printf '\n'
  if [ "$FAILURES" -eq 0 ]; then
    printf '  %sAll checks passed.%s\n\n' "$G" "$N"
  else
    printf '  %s%s check(s) failed.%s\n\n' "$R" "$FAILURES" "$N"
    exit 1
  fi
}

# --------------------------------------------------------------------- install ---

SWAP_FILE="/swapfile"
SWAP_SIZE="2G"

ensure_swap() {
  step "Swap ($SWAP_SIZE — the box has 1 GB of RAM and publishing renders every page at once)"
  if swapon --show=NAME --noheadings | grep -qx "$SWAP_FILE"; then
    ok "$SWAP_FILE is already active"
  else
    if [ ! -f "$SWAP_FILE" ]; then
      fallocate -l "$SWAP_SIZE" "$SWAP_FILE" 2>/dev/null \
        || dd if=/dev/zero of="$SWAP_FILE" bs=1M count=2048 status=none
      chmod 600 "$SWAP_FILE"
      mkswap "$SWAP_FILE" >/dev/null
    fi
    swapon "$SWAP_FILE"
    ok "swapped on"
  fi
  if grep -q "^$SWAP_FILE " /etc/fstab; then
    ok "already in /etc/fstab"
  else
    printf '%s none swap sw 0 0\n' "$SWAP_FILE" >> /etc/fstab
    ok "added to /etc/fstab, so it survives a reboot"
  fi
}

ensure_docker() {
  step "Docker"
  if have docker && docker compose version >/dev/null 2>&1; then
    ok "already installed: $(docker --version)"
  else
    have curl || die "curl is missing, and it is needed to install Docker"
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh >/dev/null
    rm -f /tmp/get-docker.sh
    ok "installed $(docker --version)"
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  systemctl is-active --quiet docker || die "docker is installed but not running"
  ok "docker is running and starts at boot"
}

ensure_firewall() {
  step "Firewall ($SSH_PORT, 80, 443 — nothing else)"
  have ufw || { have apt-get || die "no ufw and no apt-get"; apt-get update -qq; apt-get install -y -qq ufw >/dev/null; }
  ufw --force default deny incoming >/dev/null
  ufw --force default allow outgoing >/dev/null
  ufw allow "$SSH_PORT/tcp" comment 'ssh' >/dev/null
  ufw allow 80/tcp comment 'http, for the ACME challenge and the redirect to https' >/dev/null
  ufw allow 443/tcp comment 'https' >/dev/null
  if ufw status | grep -q '^Status: active'; then
    ok "rules in place, firewall already active"
  else
    warn "enabling the firewall now — SSH is allowed on port $SSH_PORT. If that is"
    warn "not where you are connected, open a second session before continuing."
    ufw --force enable >/dev/null
    ok "active"
  fi
  note "this guards the host's own services. Docker publishes 80 and 443 through"
  note "its own iptables rules, so the layer that really admits traffic is the VPC"
  note "firewall — see the summary below."
}

ensure_volume() {
  step "The volume that is the site"
  if docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
    ok "$VOLUME_NAME already exists, left exactly as it is"
    return
  fi
  docker volume create "$VOLUME_NAME" >/dev/null
  # An empty named volume comes up owned by root, and the image runs as its own
  # non-root user, so the CMS would not be able to create its database. Railway
  # solved the same problem with RAILWAY_RUN_UID=0; here the ownership can just
  # be right. The uid is read from the image rather than assumed, because
  # guessing it means a volume that works until someone publishes.
  local uid gid
  uid="$(docker run --rm --entrypoint sh "$IMAGE" -c 'id -u' 2>/dev/null || true)"
  gid="$(docker run --rm --entrypoint sh "$IMAGE" -c 'id -g' 2>/dev/null || true)"
  if printf '%s%s' "$uid" "$gid" | grep -Eq '^[0-9]+[0-9]+$'; then
    docker run --rm --user 0:0 -v "$VOLUME_NAME":/s --entrypoint sh "$IMAGE" \
      -c "chown -R $uid:$gid /s" >/dev/null
    ok "created, owned by the image's own user ($uid:$gid)"
  else
    docker run --rm --user 0:0 -v "$VOLUME_NAME":/s --entrypoint sh "$IMAGE" \
      -c 'mkdir -p /s/data /s/uploads' >/dev/null
    warn "could not read the image's uid, so $VOLUME_NAME is left open to root."
    warn "If the CMS reports a read-only or unwritable storage directory, set"
    warn "'user: \"0:0\"' on the app service in $COMPOSE_FILE — what the CMS's own"
    warn "Railway instructions do, for the same reason."
  fi
}

# --- what has to be right before anything on the box is touched ---
#
# All of this can be answered from the filesystem, so it runs before the root
# check: an argument that is wrong should not need sudo to find out.

ENV_EXISTS=0

preflight_env() {
  [ -f "$DIR/.env" ] && ENV_EXISTS=1
  # The file is mode 600 and owned by root, so a run that forgot sudo would read
  # nothing from it and be told the key is missing. Say what is actually wrong.
  if [ "$ENV_EXISTS" = "1" ] && [ ! -r "$DIR/.env" ]; then
    die "$DIR/.env exists but cannot be read by $(whoami) — run this as root: sudo $0 ${ARGS[*]:-}"
  fi

  if [ -n "$KEY_FILE" ]; then
    [ -f "$KEY_FILE" ] || die "--key-file $KEY_FILE does not exist"
    KEY="$(tr -d '\r\n' < "$KEY_FILE")"
  fi

  if [ "$ENV_EXISTS" = "1" ] && [ "$FORCE_ENV" != "1" ]; then
    local existing; existing="$(envval PUBLIC_ORIGIN)"
    if [ -n "$existing" ] && [ "$existing" != "$ORIGIN" ]; then
      die "$DIR/.env already exists with PUBLIC_ORIGIN=$existing, and you asked for $ORIGIN.
    Rewriting it is not just a config change: InStatic's CSRF check compares the
    request origin against PUBLIC_ORIGIN, so the two must agree or every login is
    rejected. Pass --force-env if the CMS really is moving to $ORIGIN."
    fi
    KEY="$(envval INSTATIC_SECRET_KEY)"
    [ -n "$KEY" ] || die "$DIR/.env has no INSTATIC_SECRET_KEY.
    Restore it from your password manager — step 0 of the runbook — and put it back
    before the CMS starts."
    # A re-run, which is what a reboot's startup script is: nothing to ask for.
    return
  fi

  [ -n "$KEY" ] || die "no INSTATIC_SECRET_KEY.
    Copy it out of the Railway service's variables (step 0 of the runbook) and pass
    it as --key-file, or in the INSTATIC_SECRET_KEY environment variable, or as the
    'instatic-secret-key' instance metadata attribute.
    Do not invent one here: it is the AES master key for existing encrypted values,
    and a new key makes them unreadable. It only has to be generated for an
    install that has no encrypted values yet, with the CMS's own
    \`bun run scripts/generate-secret-key.ts\`."
  [ "$KEY" != "replace-with-output-of-generate-secret-key" ] \
    || die "that is the placeholder from the docs, not a key"
}

ensure_config() {
  step "Configuration in $DIR"
  install -d -m 750 "$DIR"
  render_compose "$DIR"
  render_caddyfile "$DIR"

  if [ "$ENV_EXISTS" = "1" ] && [ "$FORCE_ENV" != "1" ]; then
    ok ".env kept as it is — the secret key in it cannot be replaced without"
    note "losing every encrypted value (AI provider keys, TOTP seeds)."
    ok "docker-compose.yml and Caddyfile re-rendered from the flags"
    return
  fi

  write_env "$DIR"
  ok "docker-compose.yml, Caddyfile and .env written (.env mode 600)"
}

start_stack() {
  step "Starting the CMS and Caddy"
  docker compose -f "$COMPOSE_FILE" up -d
  ok "containers are up"

  local i=0
  while [ "$i" -lt 60 ]; do
    if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"status":"ok"'; then
      ok "the CMS answers /health after $((i * 2))s"
      return
    fi
    i=$((i + 1))
    sleep 2
  done
  docker compose -f "$COMPOSE_FILE" logs --tail 40 app >&2 || true
  die "the CMS never answered /health on port $PORT (logs above, and 'docker compose -f $COMPOSE_FILE logs app')"
}

prove_tls() {
  step "TLS for $DOMAIN"
  note "Caddy asks Let's Encrypt for a certificate on first start, which needs port"
  note "80 reachable from the internet and DNS already pointing here."
  local i=0
  while [ "$i" -lt 60 ]; do
    if curl -fsS --max-time 10 "$ORIGIN/health" 2>/dev/null | grep -q '"status":"ok"'; then
      ok "$ORIGIN serves the CMS over TLS"
      if have openssl; then
        local cert
        cert="$(echo | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null \
          | openssl x509 -noout -issuer -enddate 2>/dev/null | tr '\n' ' ' || true)"
        [ -n "$cert" ] && ok "${cert#issuer=}"
      fi
      return
    fi
    i=$((i + 1))
    sleep 2
  done
  printf '\n'
  warn "no TLS answer from $ORIGIN after 120s. The CMS itself is up on this box, so"
  warn "this is DNS, the cloud firewall on ports 80 and 443, or Let's Encrypt still"
  warn "pending. Caddy retries on its own; check with:"
  note "docker compose -f $COMPOSE_FILE logs caddy"
  note "getent hosts $DOMAIN"
}

install_backup_timer() {
  step "Backups"
  local tmp; tmp="$(mktemp -d)"
  render_backup_script "$tmp"
  render_units "$tmp"
  install -m 750 -o root -g root "$tmp/backup.sh" /usr/local/sbin/msst-cms-backup
  install -m 644 -o root -g root "$tmp/msst-cms-backup.service" /etc/systemd/system/msst-cms-backup.service
  install -m 644 -o root -g root "$tmp/msst-cms-backup.timer" /etc/systemd/system/msst-cms-backup.timer
  rm -rf "$tmp"
  systemctl daemon-reload
  systemctl enable --now msst-cms-backup.timer >/dev/null 2>&1
  ok "nightly at 03:30, keeping $KEEP_DAYS days in $BACKUP_DIR"

  # Run it once. A timer that has never fired is a scheduled intention, and the
  # first night is not when you want to find out that the volume name is wrong.
  if systemctl start msst-cms-backup.service; then
    ok "ran once to prove it works"
    if [ -n "$(find "$BACKUP_DIR" -type f -print -quit 2>/dev/null)" ]; then
      find "$BACKUP_DIR" -type f -printf '    %f (%s bytes)\n'
    else
      note "nothing to archive yet: the database does not exist until the import"
      note "(step 2 of the runbook), and the CMS has not published a page."
    fi
  else
    warn "that run failed — the log is below, and the timer is installed but unproved"
    journalctl -u msst-cms-backup.service -n 30 --no-pager >&2 || true
  fi
}

summary() {
  step "Done — the host for $IMAGE is up at $ORIGIN"
  ok "the CMS is at $ORIGIN/admin (the editor), and /health answers"
  ok "the relay still points at Railway; nothing a reader sees has changed"
  printf '\n'
  printf '  %sStill to do, by hand — none of it can be done from this box:%s\n' "$B" "$N"
  printf '  %s1.%s Open 80 and 443 at the VPC firewall, from your laptop:\n' "$D" "$N"
  note "gcloud compute firewall-rules create allow-web-http --allow=tcp:80 \\"
  note "  --source-ranges=0.0.0.0/0 --target-tags=http-server"
  note "gcloud compute firewall-rules create allow-web-https --allow=tcp:443 \\"
  note "  --source-ranges=0.0.0.0/0 --target-tags=https-server"
  printf '  %s2.%s A budget alert, because the free allowance is real but not unlimited\n' "$D" "$N"
  note "(1 GB of egress a month and 30 GB of disk are the two to watch):"
  note "gcloud billing budgets create --billing-account=<id> --display-name=msst-cms \\"
  note "  --budget-amount=1 --threshold-rule=percent=0.50"
  note "(Leave the currency off --budget-amount: it has to be the billing account's own,"
  note "and naming a different one is rejected as 'Request contains an invalid argument'."
  note "percent is a fraction of the budget, not a percentage: 0.50 is half.)"
  printf '  %s3.%s Take the secret key back out of the instance metadata. Safe now:\n' "$D" "$N"
  note "the startup script keeps an existing .env and reads the key from it."
  note "gcloud compute instances remove-metadata msst-cms --keys=instatic-secret-key"
  printf '  %s4.%s Then step 2 of admin/MOVING-THE-CMS.md — import the site bundle,\n' "$D" "$N"
  note "publish once, and check the canonical tags still name the guide's address."
  printf '  %s5.%s Re-run these checks any time with: %ssudo %s --check%s\n' "$D" "$N" "$B" "${0}" "$N"
  printf '\n'
}

# ------------------------------------------------------------------------ main ---

if [ -n "$DRY_RUN" ]; then
  dry_run
  exit 0
fi

if [ "$CHECK" = "1" ]; then
  # No arguments needed beyond --origin: everything else is read back from the
  # install itself, so this checks what is on the box rather than what was asked for.
  if [ -z "$ORIGIN" ] && [ -f "$DIR/.env" ]; then
    ORIGIN="$(envval PUBLIC_ORIGIN)"
  fi
  [ -n "$ORIGIN" ] || die "--check needs --origin, or a PUBLIC_ORIGIN in $DIR/.env to read it from"
  [ "$(id -u)" -eq 0 ] || die "run the checks as root: sudo $0 ${ARGS[*]:-}
    Half of them read /etc/fstab, the firewall and a mode-600 file, and would report
    a confident failure on a healthy box without it."
  DOMAIN="${ORIGIN#https://}"
  COMPOSE_FILE="$DIR/docker-compose.yml"
  run_checks
  exit 0
fi

resolve
preflight_env

[ "$(id -u)" -eq 0 ] || die "run this as root: sudo $0 ${ARGS[*]:-}"
[ "$(uname -m)" = "x86_64" ] || die "$(uname -m) is not x86_64.
    The published InStatic image is built for linux/amd64 only, so an arm64 host
    needs a source build instead — see the CMS's own vps.md."
[ -f /etc/os-release ] || die "no /etc/os-release — this script expects Debian or Ubuntu"
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) ;;
  *) warn "${PRETTY_NAME:-this system} is not Debian or Ubuntu; continuing, but apt-get is assumed" ;;
esac
have curl || { have apt-get || die "no curl and no apt-get"; apt-get update -qq; apt-get install -y -qq curl ca-certificates >/dev/null; }

step "Provisioning $DOMAIN from $IMAGE"
note "$(uname -sr) on $(uname -m), $(awk '/MemTotal/ {printf "%.0f", $2/1024}' /proc/meminfo) MB of RAM"

ensure_swap
ensure_docker
ensure_firewall
ensure_volume
ensure_config
start_stack
prove_tls
install_backup_timer
summary
