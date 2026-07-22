#!/usr/bin/env node
/**
 * scripts/pre-push.js
 * Pre-push hook — runs before every `git push`.
 *
 * Checks:
 *   1. CF Login   — prompts login if not yet authenticated.
 *   2. CF Buildpack — reads nodejs_buildpack version for stack cflinuxfs4.
 *   3. Version comparison — fetches the matching GitHub release and verifies
 *      that the local Node.js version is bundled in that release.
 *      If it is NOT, the push is hard-blocked (process exits 1).
 */

import { execSync, spawnSync } from "node:child_process";
import https from "node:https";

// ─── Config ──────────────────────────────────────────────────────────────────

const STACK          = "cflinuxfs4";
const BUILDPACK_NAME = "nodejs_buildpack";
const GH_API         = "https://api.github.com/repos/cloudfoundry/nodejs-buildpack/releases?per_page=20";
const GH_RELEASES    = "https://github.com/cloudfoundry/nodejs-buildpack/releases";

// ─── Output helpers ──────────────────────────────────────────────────────────

const c = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  red:    "\x1b[31m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  blue:   "\x1b[34m",
};

const HR   = `  ${"─".repeat(58)}`;
const info = (...m) => console.log(`  ${c.blue}[INFO]${c.reset}  ${m.join(" ")}`);
const ok   = (...m) => console.log(`  ${c.green}[ OK ]${c.reset}  ${m.join(" ")}`);
const warn = (...m) => console.log(`  ${c.yellow}[WARN]${c.reset}  ${m.join(" ")}`);
const fail = (...m) => console.error(`  ${c.red}[FAIL]${c.reset}  ${m.join(" ")}`);

function abort(...msg) {
  fail(...msg);
  console.log(HR);
  process.exit(1);
}

// ─── Utility: run a command and return stdout, or null on error ───────────────

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
  } catch {
    return null;
  }
}

// ─── Utility: HTTPS GET → parsed JSON ────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "pre-push-hook" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(HR);
console.log(`  ${c.bold}Pre-push checks${c.reset}`);
console.log(HR);

// ── Step 1: CF Login ──────────────────────────────────────────────────────────

console.log();
info("Step 1/3 — Checking CF login status …");

const cfTarget = run("cf target");

if (!cfTarget) {
  warn("You are not logged in to Cloud Foundry.");
  console.log("\n  Launching cf login …\n");

  const loginResult = spawnSync("cf", ["login"], { stdio: "inherit" });
  if (loginResult.status !== 0) {
    abort("CF login failed. Push aborted.");
  }
  ok("CF login successful.");
} else {
  const user  = cfTarget.match(/^user:\s+(.+)$/m)?.[1]  ?? "unknown";
  const org   = cfTarget.match(/^org:\s+(.+)$/m)?.[1]   ?? "unknown";
  const space = cfTarget.match(/^space:\s+(.+)$/m)?.[1] ?? "unknown";
  ok(`Already logged in as '${user}' (org: ${org}, space: ${space}).`);
}

// ── Step 2: CF Buildpack version ─────────────────────────────────────────────

console.log();
info(`Step 2/3 — Fetching CF buildpack '${BUILDPACK_NAME}' on stack '${STACK}' …`);

const bpOutput = run("cf buildpacks");
if (!bpOutput) abort("Failed to retrieve CF buildpacks.");

// Each row: position  name  stack  enabled  locked  state  filename  lifecycle
const bpLine = bpOutput
  .split("\n")
  .find((line) => {
    const cols = line.trim().split(/\s+/);
    return cols[1] === BUILDPACK_NAME && cols[2] === STACK;
  });

if (!bpLine) abort(`'${BUILDPACK_NAME}' with stack '${STACK}' not found in CF buildpacks.`);

const cols      = bpLine.trim().split(/\s+/);
const filename  = cols[6];           // e.g. nodejs_buildpack-cached-cflinuxfs4-v1.9.2.zip
const bpVersion = filename.match(/v(\d+\.\d+\.\d+)/)?.[1];

if (!bpVersion) abort(`Could not parse version from filename: '${filename}'`);

info(`  Filename  : ${filename}`);
ok(`CF ${BUILDPACK_NAME} version on ${STACK}: v${bpVersion}`);

// ── Step 3: GitHub release comparison ────────────────────────────────────────

console.log();
info("Step 3/3 — Comparing with GitHub releases …");

let releases;
try {
  releases = await fetchJSON(GH_API);
} catch (err) {
  warn(`Could not reach GitHub API: ${err.message}`);
  warn("Skipping version comparison. Push will continue.");
  console.log(HR);
  process.exit(0);
}

const release = releases.find((r) => r.tag_name === `v${bpVersion}`);

if (!release) {
  warn(`Release 'v${bpVersion}' not found in the last 20 GitHub releases.`);
  info(`Browse manually: ${GH_RELEASES}`);
} else {
  ok(`Found GitHub release for v${bpVersion}.`);

  // Parse table rows:  | node | X.Y.Z | cflinuxfs4, cflinuxfs5 |
  const nodeRows = (release.body ?? "")
    .split("\n")
    .filter((l) => /^\|\s*node\s*\|/.test(l));

  const supportedVersions = nodeRows
    .map((row) => {
      const parts = row.split("|").map((p) => p.trim());
      // parts: ['', 'node', 'X.Y.Z', 'cflinuxfs4, cflinuxfs5 ', '']
      const version = parts[2];
      const stacks  = parts[3] ?? "";
      return stacks.includes(STACK) ? version : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (supportedVersions.length === 0) {
    warn(`No Node.js versions found for stack '${STACK}' in release notes.`);
  } else {
    info(`  Node.js versions bundled in v${bpVersion} for ${STACK}:`);
    supportedVersions.forEach((v) => console.log(`        • ${v}`));
  }

  // Local node version (strip leading 'v')
  const localNode = process.version.replace(/^v/, "");
  info(`  Local Node.js version  : v${localNode}`);

  const isSupported = supportedVersions.includes(localNode);
  const latest      = supportedVersions.at(-1);

  if (isSupported) {
    if (localNode === latest) {
      ok(`Local Node.js (v${localNode}) matches the latest bundled version.`);
    } else {
      ok(`Local Node.js (v${localNode}) is supported by v${bpVersion}/${STACK}.`);
      info(`  A newer bundled version is available: v${latest}`);
    }
  } else {
    // ── HARD BLOCK ──────────────────────────────────────────────────────────
    fail(`Local Node.js (v${localNode}) is NOT in the bundled list for v${bpVersion}/${STACK}.`);
    fail(`Supported versions: ${supportedVersions.join(", ")}`);
    fail(`Update your Node.js version or check buildpack compatibility before pushing.`);
    info(`  Releases: ${GH_RELEASES}`);
    abort("Push aborted due to Node.js version mismatch.");
  }
}

console.log(HR);
ok("All pre-push checks passed. Proceeding with push.");
console.log(HR);
process.exit(0);
