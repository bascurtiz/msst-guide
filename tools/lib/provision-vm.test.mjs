/**
 * The provisioner behind `tools/provision-vm.sh`.
 *
 * Bash, not Node, because what it provisions is a Debian host and a fresh one has
 * no Node to run anything else with. That makes this the one tool here that needs
 * a shell to test, so the tests are skipped where there is none (a Windows
 * checkout without Git Bash) rather than failing.
 *
 * Everything below drives `--dry-run`, which is the script's own renderer writing
 * its own files somewhere harmless. It is not a description of what the script
 * would do — the same functions produce both — so these are assertions about the
 * real output, not about a summary of it.
 *
 * What is worth asserting is mostly cross-file agreement, because that is where
 * this can be wrong while looking right: one port number appears in four files,
 * the volume's name is declared in the Compose file and consumed by the backup
 * script, and the origin has to match in the Caddyfile and in `PUBLIC_ORIGIN` or
 * every login is rejected. Each of those is a check here.
 *
 * The install path itself needs root, so it is not exercised here — it is what
 * `--check` is for, on the box.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "provision-vm.sh");
const ORIGIN = "https://34-71-12-9.sslip.io";
const IMAGE = "ghcr.io/corebunch/instatic:0.0.20";

const HAVE_BASH = spawnSync("bash", ["-c", "exit 0"]).status === 0;
const SKIP = HAVE_BASH ? {} : { skip: "bash is not on PATH — the provisioner is a Linux script" };

/** Run the provisioner, with the secret key unset unless a test sets it. */
function provision(args, { env = {} } = {}) {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, INSTATIC_SECRET_KEY: "", ...env },
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** A temp directory, cleaned up when the test that made it finishes. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "msst-provision-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A directory the provisioner itself will accept as `--dir`, made with bash
 * rather than with Node. It has to be absolute in *the script's* terms and
 * readable by the script: on Windows Node's `/tmp` is `C:\\tmp` and Git Bash's
 * is somewhere else entirely, so a fixture made here would be invisible to the
 * script and the failure would be the test's fault rather than the script's.
 */
function posixDir(t) {
  const dir = `/tmp/msst-provision-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const made = spawnSync("bash", ["-c", `mkdir -p ${dir}`], { encoding: "utf8" });
  assert.equal(made.status, 0, "could not make a directory for the fixture");
  t.after(() => spawnSync("bash", ["-c", `rm -rf ${dir}`]));
  return dir;
}

/** Render the configuration into a fresh directory and return the files. */
function render(t, args = []) {
  const dir = scratch(t);
  const out = join(dir, "config");
  const result = provision(["--dry-run", out, "--origin", ORIGIN, "--image", IMAGE, ...args]);
  assert.equal(result.status, 0, `the dry run failed:\n${result.output}`);
  const read = (name) => readFileSync(join(out, name), "utf8");
  return {
    dir,
    out,
    output: result.output,
    compose: read("docker-compose.yml"),
    caddy: read("Caddyfile"),
    env: read(".env"),
    backup: read("backup.sh"),
    service: read("msst-cms-backup.service"),
    timer: read("msst-cms-backup.timer"),
  };
}

test("dry run renders the Stack the CMS runs in, and needs neither root nor a key", SKIP, (t) => {
  const { compose, output } = render(t);

  assert.match(compose, /^name: msst-cms$/m, "the project name is what fixes the volume's name");
  assert.match(compose, new RegExp(`image: ${IMAGE.replace(/\./g, "\\.")}`));
  assert.match(compose, /- storage:\/app\/storage/, "database and uploads both under one volume");
  assert.match(compose, /"127\.0\.0\.1:3001:3001"/, "the app must not be published on a public interface");
  assert.match(compose, /- "80:80"/);
  assert.match(compose, /- "443:443"/);
  assert.match(compose, /condition: service_healthy/, "Caddy must wait for the CMS, or a first boot is 502s");
  assert.match(compose, /\/health/);

  assert.match(output, /nothing on this machine was touched/);
  assert.match(output, /--metadata-from-file=startup-script/, "the one-command form is printed");
});

test("the port is the same number in every file it appears in", SKIP, (t) => {
  const { compose, caddy, env } = render(t, ["--port", "8080"]);

  assert.match(env, /^PORT=8080$/m);
  assert.match(compose, /"127\.0\.0\.1:8080:8080"/);
  assert.match(compose, /fetch\('http:\/\/127\.0\.0\.1:8080\/health'\)/, "the health check follows the port");
  assert.match(caddy, /reverse_proxy app:8080/);
});

test("the origin is the Caddy site address, and the email is only there when asked for", SKIP, (t) => {
  const plain = render(t);
  assert.match(plain.caddy, /^34-71-12-9\.sslip\.io \{$/m);
  assert.match(plain.caddy, /reverse_proxy app:3001/);
  assert.doesNotMatch(plain.caddy, /email /);

  const withEmail = render(t, ["--email", "ops@example.com"]);
  assert.match(withEmail.caddy, /email ops@example\.com/);
});

test("the .env holds the CMS's contract, and a dry run never writes the key", SKIP, (t) => {
  const secret = "dGhpc2lzYXRlc3RrZXlub3RyZWFs";
  const { env, output } = render(t);

  assert.match(env, /^DATABASE_URL=sqlite:\/app\/storage\/data\/cms\.db$/m);
  assert.match(env, /^UPLOADS_DIR=\/app\/storage\/uploads$/m);
  assert.match(env, /^STATIC_DIR=\/app\/dist$/m);
  assert.match(env, new RegExp(`^PUBLIC_ORIGIN=${ORIGIN}$`, "m"), "must match the origin the browser sends");

  // Even with the key in the environment, a preview must not carry it: previews
  // get pasted into tickets and read back out of logs.
  const dir = scratch(t);
  const out = join(dir, "config");
  const withKey = provision(["--dry-run", out, "--origin", ORIGIN, "--image", IMAGE], {
    env: { INSTATIC_SECRET_KEY: secret },
  });
  assert.equal(withKey.status, 0);
  assert.doesNotMatch(`${output}${withKey.output}`, new RegExp(secret), "the key reached the output");
  assert.doesNotMatch(readFileSync(join(out, ".env"), "utf8"), new RegExp(secret), "the key reached the file");
});

test("the backup script covers both halves of the site, live, once", SKIP, (t) => {
  const { backup, compose, out } = render(t, ["--dir", "/srv/cms"]);

  const syntax = spawnSync("bash", ["-n", join(out, "backup.sh")], { encoding: "utf8" });
  assert.equal(syntax.status, 0, `the emitted backup script does not parse:\n${syntax.stderr}`);

  assert.match(backup, /VACUUM INTO/, "a consistent copy, without stopping the CMS");
  assert.match(backup, /flock -n 9/, "two runs must not race");
  assert.match(backup, /compose exec -T app test -f "\$DB"/, "no database yet is not a failure");
  assert.match(backup, /-v "\$VOLUME":\/src:ro/, "the uploads archive comes off the volume");
  assert.match(backup, /-mtime \+"\$KEEP_DAYS" -delete/, "retention");

  // The volume name has to be the one Compose actually creates, which is the
  // project name plus the volume key. This is the invariant that a rename in one
  // file and not the other would break, silently, at 03:30.
  const project = compose.match(/^name: (.+)$/m)[1];
  assert.equal(project, "msst-cms");
  assert.match(backup, new RegExp(`^VOLUME=${project}_storage$`, "m"));
  assert.match(backup, /^COMPOSE_FILE=\/srv\/cms\/docker-compose\.yml$/m, "the path it was given, not a default");
});

test("the timer runs the backup nightly and survives a reboot", SKIP, (t) => {
  const { service, timer } = render(t);

  assert.match(service, /^ExecStart=\/usr\/local\/sbin\/msst-cms-backup$/m);
  assert.match(service, /^After=docker\.service$/m);
  assert.match(timer, /^OnCalendar=\*-\*-\* 03:30:00$/m);
  assert.match(timer, /^Persistent=true$/m, "a box that was off at 03:30 still gets backed up");
  assert.match(timer, /^WantedBy=timers\.target$/m);
});

test("the arguments that would cost you the site are refused", SKIP, (t) => {
  const dir = scratch(t);

  const latest = provision(["--dry-run", join(dir, "a"), "--origin", ORIGIN, "--image", "ghcr.io/corebunch/instatic:latest"]);
  assert.equal(latest.status, 1);
  assert.match(latest.output, /pinned release/);

  const http = provision(["--dry-run", join(dir, "b"), "--origin", "http://guide.example.com", "--image", IMAGE]);
  assert.equal(http.status, 1);
  assert.match(http.output, /must be https/);

  const path = provision(["--dry-run", join(dir, "c"), "--origin", `${ORIGIN}/admin`, "--image", IMAGE]);
  assert.equal(path.status, 1, "an origin with a path is not what the browser sends");

  const unknown = provision(["--nonsense"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.output, /unknown argument/);

  const help = provision(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.output, /--key-file/);
});

test("a fresh install without the secret key stops before it touches anything", SKIP, (t) => {
  const result = provision([
    "--origin", ORIGIN, "--image", IMAGE, "--dir", `${posixDir(t)}/opt`,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.output, /no INSTATIC_SECRET_KEY/);
  assert.match(result.output, /Railway service's variables/, "the runbook is where it comes from");
});

test("moving the origin on an existing install is refused, because logins would break", SKIP, (t) => {
  const install = `${posixDir(t)}/opt`;
  const seeded = spawnSync("bash", ["-c", `mkdir -p ${install} && printf 'PUBLIC_ORIGIN=https://old.example.com\\nINSTATIC_SECRET_KEY=a-key\\n' > ${install}/.env`]);
  assert.equal(seeded.status, 0, "could not seed the existing install");

  const moved = provision(["--origin", "https://new.example.com", "--image", IMAGE, "--dir", install]);
  assert.equal(moved.status, 1);
  assert.match(moved.output, /already exists with PUBLIC_ORIGIN=https:\/\/old\.example\.com/);
  assert.match(moved.output, /--force-env/);

  // Same origin: a re-run — which is what a reboot's startup script is — must not
  // ask for the key again, because the file it already has is the only copy.
  const again = provision(["--origin", "https://old.example.com", "--image", IMAGE, "--dir", install]);
  assert.doesNotMatch(again.output, /no INSTATIC_SECRET_KEY/);
  assert.match(again.output, /run this as root/, "it gets as far as needing privileges, not a key");
});
