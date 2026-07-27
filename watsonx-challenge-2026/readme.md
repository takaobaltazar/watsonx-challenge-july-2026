# CF Pre-Push Buildpack Check

Automatically blocks `git push` when your local Node.js version is not
supported by the `nodejs_buildpack` installed in your target CF environment.
The check runs entirely inside `.githooks/pre-push` — no extra tooling needed.

The only escape hatch is `git push --no-verify`.

---

## How to run
  
### 1. Clone the repo

```sh
git clone <repo-url>
cd watsonx-challenge-2026
```

### 2. Install dependencies (activates the hook automatically)

```sh
npm install
```

`npm install` triggers the `prepare` script which runs `git config core.hooksPath .githooks`.
The pre-push hook is now active. You do **not** need to do anything else.

Verify the hook is wired up:

```sh
git config core.hooksPath
# expected output: .githooks
```

### 3. Log in to Cloud Foundry

The hook calls `cf buildpacks`, so you must be logged in before pushing:

```sh
cf login
```

### 4. Push normally

```sh
git add .
git commit -m "your message"
git push
```

The hook fires automatically on `git push`. Output appears in the same terminal.

---

## What you will see in the terminal

### ✅ Push allowed — versions match

```
[cf-pre-push] Fetching manifest: https://raw.githubusercontent.com/cloudfoundry/nodejs-buildpack/v1.8.22/manifest.yml
[cf-pre-push] CF buildpack         : nodejs_buildpack
[cf-pre-push] CF stack             : cflinuxfs4
[cf-pre-push] CF filename          : nodejs-buildpack-cflinuxfs4-v1.8.22.zip
[cf-pre-push] CF buildpack version : v1.8.22
[cf-pre-push] Manifest URL         : https://raw.githubusercontent.com/cloudfoundry/nodejs-buildpack/v1.8.22/manifest.yml
[cf-pre-push] Supported Node.js    : 20.19.2, 18.20.8
[cf-pre-push] Local Node.js        : 20.19.2
[cf-pre-push] ✔  Node.js v20.19.2 is supported — push allowed.
```

Git proceeds with the push immediately after.

### ⛔ Push blocked — version mismatch

A native OS popup appears **and** the terminal prints:

```
╔══════════════════════════════════════════════════════════════════╗
║  ⛔  CF PRE-PUSH BLOCKED                                          ║
╠══════════════════════════════════════════════════════════════════╣
║ Local Node.js v22.0.0 is NOT supported by                        ║
║ nodejs_buildpack v1.8.22 on cflinuxfs4.                          ║
║ Supported versions: 20.19.2, 18.20.8                             ║
║ Switch Node version (e.g. nvm use <version>) and try again.      ║
╠══════════════════════════════════════════════════════════════════╣
║ Fix the issue above, then push again.                            ║
║ To skip this check (NOT recommended): git push --no-verify       ║
╚══════════════════════════════════════════════════════════════════╝
```

Git aborts. Nothing is sent to the remote.

To fix: switch to a supported Node version, then push again:
 
```sh
nvm use 20        # or whichever version is listed as supported
git push
```

---

## Prerequisites

| Tool | Purpose |
|------|---------| 
| `node` | Runs the hook script; version is checked against the buildpack manifest |
| `cf` CLI | Reads the installed buildpack and stack from your CF target |
| `curl` | Fetches the raw `manifest.yml` from GitHub |

---

## How it works

1. `cf target` — confirms you are logged in to CF.
2. `cf buildpacks` — finds the `nodejs_buildpack` row for stack `cflinuxfs4`.
3. Extracts the buildpack version from the `.zip` filename (e.g. `v1.8.22`).
4. Fetches the raw manifest directly from GitHub:
   ```
   https://raw.githubusercontent.com/cloudfoundry/nodejs-buildpack/v1.8.22/manifest.yml
   ```
5. Parses every `node` dependency block whose `cf_stacks` includes `cflinuxfs4`.
6. Compares the list against your local `node -v`.
7. **Blocks the push (exit 1) + shows a popup** if your version is not supported.

---

## Bypassing the check

Only in emergencies — this skips the hook entirely:

```sh
git push --no-verify
```
# test
# test

<!-- test: trigger pre-push block -->

<!-- test: pre-push block attempt 2 -->
# test
