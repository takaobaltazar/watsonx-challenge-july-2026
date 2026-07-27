#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── load .env (no external deps — plain key=value parser) ───────────────────

function loadEnv() {
  const dir = dirname(fileURLToPath(import.meta.url));
  // Look for .env in the project root (one level up from scripts/)
  const envPath = resolve(dir, '..', '.env');
  try {
    return Object.fromEntries(
      readFileSync(envPath, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith('#'))
        .map((l) => l.split('=').map((p) => p.trim()))
        .filter(([k]) => k),
    );
  } catch {
    return {}; // .env is optional — fall back to defaults below
  }
}

const env = loadEnv();

// Constants — override via .env (see .env.example)
const REQUIRED_STACK     = env.CF_REQUIRED_STACK     ?? 'cflinuxfs4';
const REQUIRED_BUILDPACK = env.CF_REQUIRED_BUILDPACK ?? 'nodejs_buildpack';

// Raw manifest.yml from the cloudfoundry/nodejs-buildpack GitHub repo.
// The version tag is resolved at runtime from 'cf buildpacks'.
// e.g. https://raw.githubusercontent.com/cloudfoundry/nodejs-buildpack/v1.8.22/manifest.yml
const RAW_MANIFEST_BASE =
  env.CF_RAW_MANIFEST_BASE ?? 'https://raw.githubusercontent.com/cloudfoundry/nodejs-buildpack';

// ─── helpers ────────────────────────────────────────────────────────────────

function runCommand(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Hard-error: print a boxed, visually prominent error block to stderr then
 * exit(1).  This is the "popup" equivalent for a terminal hook — it is
 * impossible to miss even when scrolling through dense build logs.
 */
function fail(message) {
  const lines   = message.split('\n');
  const width   = Math.max(...lines.map((l) => l.length), 60);
  const border  = '═'.repeat(width + 2);
  const padLine = (l) => `║ ${l.padEnd(width)} ║`;

  const box = [
    '',
    `╔${border}╗`,
    `║  ${'⛔  CF PRE-PUSH BLOCKED'.padEnd(width - 1)}║`,
    `╠${border}╣`,
    ...lines.map(padLine),
    `╠${border}╣`,
    padLine('Fix the issue above, then push again.'),
    padLine('To skip this check (NOT recommended): git push --no-verify'),
    `╚${border}╝`,
    '',
  ].join('\n');

  process.stderr.write(box + '\n');
  process.exit(1);
}

function warn(message) {
  console.warn(`[cf-pre-push] ⚠  WARNING: ${message}`);
}

// ─── CF buildpack line parsing ───────────────────────────────────────────────

function parseBuildpackLine(output) {
  const line = output
    .split(/\r?\n/)
    .find((entry) => entry.includes(REQUIRED_BUILDPACK) && entry.includes(REQUIRED_STACK));

  if (!line) {
    fail(
      `Could not find "${REQUIRED_BUILDPACK}" for stack "${REQUIRED_STACK}"\n` +
      `in the output of 'cf buildpacks'.`,
    );
  }

  const parts      = line.trim().split(/\s+/);
  const stackIndex = parts.indexOf(REQUIRED_STACK);
  const filename   = parts[stackIndex + 4];

  if (!filename) {
    fail(`Could not parse buildpack filename from CF output line:\n  ${line}`);
  }

  const versionMatch = filename.match(/-v(\d+\.\d+\.\d+)\.zip$/);

  if (!versionMatch) {
    fail(`Could not extract a semver version from buildpack filename:\n  ${filename}`);
  }

  return {
    filename,
    version: `v${versionMatch[1]}`,
  };
}

// ─── raw manifest.yml parsing ────────────────────────────────────────────────

/**
 * Build the raw manifest URL for the resolved buildpack version tag.
 *
 * Example:
 *   https://raw.githubusercontent.com/cloudfoundry/nodejs-buildpack/v1.8.22/manifest.yml
 */
function manifestUrl(version) {
  return `${RAW_MANIFEST_BASE}/${version}/manifest.yml`;
}

/**
 * Fetch the raw manifest.yml text via curl (no extra deps needed).
 */
function fetchManifest(version) {
  const url = manifestUrl(version);
  console.log(`[cf-pre-push] Fetching manifest: ${url}`);

  let body;
  try {
    body = runCommand('curl', ['-fsSL', '--user-agent', 'cf-pre-push', url]);
  } catch {
    fail(
      `Unable to fetch buildpack manifest for ${version}.\n` +
      `URL: ${manifestUrl(version)}\n` +
      `Check your internet connection or VPN settings.`,
    );
  }

  if (!body || body.trim().length === 0) {
    fail(
      `Empty response when fetching buildpack manifest for ${version}.\n` +
      `URL: ${manifestUrl(version)}`,
    );
  }

  return body;
}

/**
 * Parse supported Node.js versions for the target stack directly from the
 * raw manifest.yml text.  The manifest uses a 'dependencies' list where each
 * entry has  name / version / cf_stacks  fields (plain YAML, no library needed).
 *
 * Relevant block shape:
 *   - name: node
 *     version: 20.19.2
 *     cf_stacks:
 *       - cflinuxfs4
 */
function parseNodeVersionsFromManifest(yaml, stack) {
  const versions = [];

  // Split into dependency blocks on lines starting with '- name:'
  const blocks = yaml.split(/^- name:/m);

  for (const block of blocks) {
    // Only process node dependency blocks
    if (!block.match(/^\s*node\s*$/m)) continue;

    // Collect cf_stacks list items line-by-line (regex lookahead was unreliable
    // across manifest format versions where \Z is not valid JS).
    const cfStacksIdx = block.indexOf('cf_stacks:');
    if (cfStacksIdx === -1) continue;

    const stackList = [];
    for (const line of block.slice(cfStacksIdx + 'cf_stacks:'.length).split('\n')) {
      const item = line.match(/^\s+-\s+(\S+)/);
      if (item) { stackList.push(item[1]); continue; }
      if (line.match(/^\s+\S/) && stackList.length > 0) break; // non-list key ends section
    }

    if (!stackList.includes(stack)) continue;

    // Only exact semver x.y.z (skip wildcard "22.x" default_versions entries)
    const verMatch = block.match(/version:\s*["']?(\d+\.\d+\.\d+)["']?/);
    if (verMatch) {
      versions.push(verMatch[1]);
    }
  }

  if (versions.length === 0) {
    fail(
      `No Node.js versions found in buildpack manifest for stack "${stack}".\n` +
      `This may mean the manifest format changed — please inspect it manually.`,
    );
  }

  return [...new Set(versions)].sort((a, b) => {
    const [aMaj, aMin, aPat] = a.split('.').map(Number);
    const [bMaj, bMin, bPat] = b.split('.').map(Number);
    return bMaj - aMaj || bMin - aMin || bPat - aPat;
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

function main() {
  // 1. Verify CF login
  try {
    runCommand('cf', ['target']);
  } catch {
    fail('CF login required.\nRun "cf login" before pushing.');
  }

  // 2. Read installed buildpacks
  let buildpacksOutput;
  try {
    buildpacksOutput = runCommand('cf', ['buildpacks']);
  } catch {
    fail('Unable to read CF buildpacks.\nVerify your CF CLI session and permissions.');
  }

  const buildpack = parseBuildpackLine(buildpacksOutput);

  // 3. Read local Node.js version
  let localNodeVersion;
  try {
    localNodeVersion = runCommand('node', ['-v']).replace(/^v/, '');
  } catch {
    fail('Unable to execute "node -v" locally.\nInstall Node.js or fix your PATH.');
  }

  // 4. Fetch + parse the raw manifest.yml
  const manifest             = fetchManifest(buildpack.version);
  const supportedNodeVersions = parseNodeVersionsFromManifest(manifest, REQUIRED_STACK);

  // 5. Report
  console.log(`[cf-pre-push] CF buildpack         : ${REQUIRED_BUILDPACK}`);
  console.log(`[cf-pre-push] CF stack             : ${REQUIRED_STACK}`);
  console.log(`[cf-pre-push] CF filename          : ${buildpack.filename}`);
  console.log(`[cf-pre-push] CF buildpack version : ${buildpack.version}`);
  console.log(`[cf-pre-push] Manifest URL         : ${manifestUrl(buildpack.version)}`);
  console.log(`[cf-pre-push] Supported Node.js    : ${supportedNodeVersions.join(', ')}`);
  console.log(`[cf-pre-push] Local Node.js        : ${localNodeVersion}`);

  // 6. Version check — hard block if local Node is not in the supported list
  if (!supportedNodeVersions.includes(localNodeVersion)) {
    fail(
      `Local Node.js v${localNodeVersion} is NOT supported by\n` +
      `${REQUIRED_BUILDPACK} ${buildpack.version} on ${REQUIRED_STACK}.\n` +
      `Supported versions: ${supportedNodeVersions.join(', ')}\n` +
      `Switch Node version (e.g. nvm use <version>) and try again.`,
    );
  }

  console.log(`[cf-pre-push] ✔  Node.js v${localNodeVersion} is supported — push allowed.`);
}

main();
