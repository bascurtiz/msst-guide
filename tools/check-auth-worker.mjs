#!/usr/bin/env node
/**
 * Check that a deployed Sveltia authenticator Worker is ready for the editor.
 *
 *   node tools/check-auth-worker.mjs https://sveltia-cms-auth.<sub>.workers.dev
 *   node tools/check-auth-worker.mjs <url> --domain msst-guide.pages.dev
 *   node tools/check-auth-worker.mjs <url> --client-id <the OAuth app's client id>
 *
 * The editor builds `<base_url>/auth?provider=github&site_id=<hostname>&scope=…`
 * and expects a redirect to GitHub; GitHub then returns to `<base_url>/callback`.
 * Every way of getting this wrong — a missing client ID, a callback URL that
 * doesn't match, `ALLOWED_DOMAINS` naming the wrong host — shows up as an error
 * page from the Worker rather than as a failed sign-in you can diagnose, and the
 * person who sees it is the author, mid-edit. So this asks the Worker the same
 * questions the editor will, and reports what it says.
 *
 * No dependencies, and nothing here signs in: it checks the Worker is *configured*,
 * which is the part that cannot be fixed from the editor's side.
 */

const PROVIDER = "github";
const HEX32 = /^[0-9a-f]{32}$/;

const args = process.argv.slice(2);
const KNOWN_FLAGS = ["--domain", "--client-id"];
const USAGE =
  "usage: node tools/check-auth-worker.mjs <worker-url> [--domain <hostname>] [--client-id <id>]";

// Refuse unknown flags rather than ignoring them: a typo'd `--domian` that ran
// anyway would report on the wrong hostname while looking like a clean pass.
const unknown = args.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.includes(a));
if (unknown.length) {
  console.error(`${USAGE}\n\nunknown option: ${unknown.join(", ")}`);
  process.exit(2);
}

/** Read `--name <value>`, insisting on the value. */
function flag(name) {
  const at = args.indexOf(name);
  if (at === -1) return null;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) {
    console.error(`${USAGE}\n\nmissing value for ${name}`);
    process.exit(2);
  }
  return value;
}

// The URL is the one bare argument: anything else is the value of a flag above.
let url = null;
for (let i = 0; i < args.length; i++) {
  if (KNOWN_FLAGS.includes(args[i])) {
    i += 1;
    continue;
  }
  url ??= args[i];
}

const domain = flag("--domain") ?? "msst-guide.pages.dev";
const expectedClientId = flag("--client-id");

if (!url) {
  console.error(USAGE);
  process.exit(2);
}

let base = url.replace(/\/+$/, "");
if (base !== url) console.log(`note: ignoring the trailing slash in ${url} — the editor appends /auth itself\n`);

// A URL that already ends in an endpoint is a paste from the wrong place — the
// browser's address bar after a redirect, or the OAuth app's callback field. The
// editor appends `/auth` to whatever it is given, so this value in `base_url`
// would give `…/auth/auth`. Strip it so the Worker still gets checked, but say so.
const ENDPOINT = /\/(?:auth|callback|oauth\/(?:authorize|redirect))$/;
const pastedEndpoint = ENDPOINT.exec(base);
if (pastedEndpoint) base = base.slice(0, -pastedEndpoint[0].length);

const results = [];
const record = (status, label, detail = "") => {
  results.push({ status, label });
  console.log(`${status.padEnd(4)} ${label}${detail ? `\n       ${detail}` : ""}`);
};

/** The Worker answers errors as an HTML page that posts a message to its opener. */
const errorCode = (html) => (html.match(/"errorCode":"([A-Z_]+)"/) || [])[1];
const errorText = (html) => (html.match(/"error":"([^"]+)"/) || [])[1];

async function get(path) {
  const response = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(20000) });
  const body = await response.text();
  return { response, body };
}

if (pastedEndpoint) {
  record(
    "WARN",
    `the URL ended in ${pastedEndpoint[0]}, which the editor appends itself`,
    `checked ${base} instead — but note that base_url must be the Worker's origin, with no path`
  );
}

// --- 1. does /auth send the browser to GitHub, with a usable client id? ------

console.log(`checking ${base} for site_id ${domain}\n`);

try {
  const { response, body } = await get(`/auth?provider=${PROVIDER}&site_id=${domain}&scope=public_repo`);
  if (response.status === 200) {
    const code = errorCode(body) ?? "unknown";
    const advice = {
      MISCONFIGURED_CLIENT: "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not set on the Worker.",
      UNSUPPORTED_DOMAIN: `ALLOWED_DOMAINS does not cover ${domain}.`,
      UNSUPPORTED_BACKEND: "the Worker was asked for a provider it does not support.",
    }[code];
    record("FAIL", "/auth does not redirect to GitHub", `the Worker answered with ${code}: ${errorText(body)}${advice ? ` — ${advice}` : ""}`);
  } else if (response.status !== 302) {
    record("FAIL", `/auth answered ${response.status}, expected a 302 to GitHub`);
  } else {
    const location = response.headers.get("location") ?? "";
    const target = new URL(location);
    const params = target.searchParams;
    const clientId = params.get("client_id");
    const state = params.get("state");
    const scope = params.get("scope");

    if (target.hostname !== "github.com" || !target.pathname.startsWith("/login/oauth/authorize")) {
      record("FAIL", "/auth redirects somewhere other than GitHub's authorize endpoint", location);
    } else {
      record("PASS", "/auth redirects to GitHub's authorize endpoint");
    }

    if (!clientId) {
      record("FAIL", "no client_id in the redirect", "GITHUB_CLIENT_ID is not set");
    } else if (expectedClientId && clientId !== expectedClientId) {
      record(
        "FAIL",
        "the redirect's client_id does not match the OAuth app",
        `expected ${expectedClientId.slice(0, 6)}…, got ${clientId.slice(0, 6)}… — the Worker holds a different app's id`
      );
    } else {
      record(
        "PASS",
        `client_id present (${clientId.slice(0, 6)}…, ${clientId.length} characters)${
          expectedClientId ? ", and it is the expected one" : " — pass --client-id to confirm it is the app's own"
        }`
      );
    }

    if (!state || !HEX32.test(state)) record("WARN", "state is missing or not a 32-character hex string", "CSRF protection is weaker than expected");
    else record("PASS", "state is a fresh 32-character hex string");

    // The cookie is what proves the Worker generated that state rather than echoing it.
    const cookie = response.headers.get("set-cookie") ?? "";
    if (cookie.includes(`csrf-token=${PROVIDER}_${state}`)) record("PASS", "the matching csrf-token cookie is set");
    else if (cookie.includes("csrf-token=deleted")) record("PASS", "a stale csrf-token cookie is being cleared");
    else record("WARN", "no csrf-token cookie alongside the state", cookie || "(no Set-Cookie header)");

    if (scope && !/(^|,)(public_repo|repo)(,|$)/.test(scope)) {
      record("WARN", `unexpected scope "${scope}"`, "expected public_repo or repo");
    } else if (scope?.includes("repo") && !scope.includes("public_repo")) {
      record("WARN", `the sign-in will ask for "${scope}"`, "that is full control of private repositories — auth_scope is missing from admin/config.yml?");
    } else {
      record("PASS", `the sign-in will ask for "${scope}"`);
    }
  }
} catch (error) {
  record("FAIL", "/auth could not be reached", `${error.name}: ${error.message}`);
}

// --- 2. does /callback answer, rather than 404 or crash? ---------------------

try {
  const { response, body } = await get("/callback");
  if (response.status >= 500) {
    record("FAIL", `/callback answered ${response.status}`, "the OAuth app's callback URL may not match this Worker");
  } else if (errorCode(body)) {
    record("PASS", "/callback is routed", `it refuses a request with no code, as it should (${errorCode(body)})`);
  } else {
    record("WARN", `/callback answered ${response.status} without an error page`, "routing works, but the response is not what this check expected");
  }
} catch (error) {
  record("FAIL", "/callback could not be reached", `${error.name}: ${error.message}`);
}

// --- 3. is ALLOWED_DOMAINS actually enforced? --------------------------------

const stranger = "someone-elses-site.example";
try {
  const { response, body } = await get(`/auth?provider=${PROVIDER}&site_id=${stranger}&scope=public_repo`);
  if (response.status === 200 && errorCode(body) === "UNSUPPORTED_DOMAIN") {
    record("PASS", "ALLOWED_DOMAINS is enforced", `a request for ${stranger} is refused`);
  } else if (response.status === 302) {
    record("WARN", "ALLOWED_DOMAINS is not set", "the sign-in will work, but anyone may use this Worker at your expense");
  } else {
    record("WARN", `unexpected answer for a foreign domain (${response.status})`);
  }
} catch (error) {
  record("WARN", "the foreign-domain probe could not be made", `${error.name}: ${error.message}`);
}

// --- verdict -----------------------------------------------------------------

const failed = results.filter((r) => r.status === "FAIL");
const warned = results.filter((r) => r.status === "WARN");
console.log(`\n${results.length - failed.length - warned.length} passed, ${warned.length} warning(s), ${failed.length} failed`);
if (failed.length) {
  console.log("\nThe sign-in button will not work yet. Fix the failures above before giving the author the URL.");
} else if (warned.length) {
  console.log("\nThe sign-in button will work. The warnings are about what it lets through, not whether it works.");
} else {
  console.log("\nThe Worker is ready. Set base_url in admin/config.yml to this URL and the button will work.");
}

// Set the code rather than exiting: `process.exit()` here tears the process down
// while `fetch`'s sockets are still closing, which on Windows trips a libuv
// assertion and replaces the exit code with a crash. The event loop drains on
// its own a moment later, with the code intact.
process.exitCode = failed.length ? 1 : 0;
