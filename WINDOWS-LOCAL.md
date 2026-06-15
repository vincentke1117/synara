# Windows-local patch (fork-only — do NOT submit upstream)

This branch (`windows-local`) carries a **local-only** patch that makes Synara reliably
discover and launch provider CLIs (codex, claude, gemini, cursor, grok, opencode, kilo) on
Windows. It is **not** intended for the upstream project — keep it on this fork only and
never open a PR against `upstream`.

## Why

On Windows the CLIs fail to launch inside Synara when they are installed in a non-default
location or via a non-default method, or when the server process inherits a stale `PATH`:

- The persisted-registry `PATH` enrichment (`syncShellEnvironment`) only ran in the Electron
  desktop bootstrap; the server itself never enriched `PATH`, and `buildCodexProcessEnv`
  enriched `PATH` only on macOS/Linux (no win32 branch).
- A GUI/desktop-launched process often inherits a `PATH` that omits a custom **npm global
  prefix** (e.g. `~/.npmrc` `prefix=`), or `scoop\shims`, `AppData\Local\pnpm`, `.bun\bin`,
  `Volta\bin`, etc., so a bare `codex`/`claude` ENOENTs even though `where codex` works in a
  terminal.
- The OpenCode/Kilo `serve` process was spawned without `shell:true`, so Node could not exec
  the npm `.cmd` shim.
- The codex discovery session hardcoded `spawn("codex")`, ignoring a configured `binaryPath`.
- `shell:true` + an args array concatenates the command unquoted, so a custom `binaryPath`
  containing a space (e.g. under `C:\Program Files\...`) was split and failed.

## What it changes

- **New** `packages/shared/src/binaryResolution.ts` (+ tests): `resolveExecutablePath`
  (PATHEXT-aware `which`), `windowsCliBinDirs` (probes the npm prefix parsed from `~/.npmrc`
  plus the common Windows bin dirs), `enrichWindowsPathForSpawn`, and `quoteForWindowsShell`.
  Reuses the existing `shell.ts` registry/PATH helpers.
- **Universal chokepoint:** enrich `process.env.PATH` once at server bootstrap
  (`apps/server/src/index.ts`). Every provider spawn inherits it, in both packaged-desktop
  and dev. Plus a win32 branch in `buildCodexProcessEnv` (`codexProcessEnv.ts`).
- Add `shell:true` to the OpenCode/Kilo `serve` spawn (`opencodeRuntime.ts`).
- Thread the configured codex `binaryPath` into the discovery session
  (`codexAppServerManager.ts`, `CodexAdapter.ts`).
- Wrap the command with `quoteForWindowsShell` at every win32 `shell:true` spawn site so a
  custom `binaryPath` with spaces works. (We keep `shell:true` and quote — **not**
  `shell:false` — because Node throws `EINVAL` when exec'ing a `.cmd` with `shell:false`,
  while npm-installed CLIs are `.cmd` shims.)

Two further packaged-desktop fixes (surfaced once the app actually launched the CLIs):

- **Claude — "native binary not found at claude".** `ClaudeAdapter.ts` forced
  `pathToClaudeCodeExecutable: "claude"`, which defeats the Agent SDK's own resolution of
  its bundled native `claude.exe` (the one that ships in the installer). The SDK spawns with
  `shell:false`, so a `.cmd` would `EINVAL`. Fix: **omit** the option when no custom
  `binaryPath` (let the SDK use the bundled `claude.exe`), at session start *and* command
  discovery; a configured `binaryPath` is honored. See `resolveClaudeExecutable`.
- **Codex — 401 Unauthorized.** The packaged app runs codex against an overlay `CODEX_HOME`
  that **symlinks** `auth.json` from `~/.codex`. Node `symlinkSync` throws `EPERM` on Windows
  without Developer Mode, and the overlay-prep loop aborted on the first failing entry — so
  `auth.json` never reached the overlay and codex ran unauthenticated. Fix in
  `codexProcessEnv.ts`: per-entry isolation (one bad entry no longer aborts the loop),
  auth-first ordering, and a **copy fallback** for `auth.json` when symlinking is refused.

## Keeping it across upstream updates

```bash
git checkout main
git fetch upstream
git merge --ff-only upstream/main
git push origin main                # optional: keep the fork's main in sync

git checkout windows-local
git rebase main                     # resolve conflicts here (usually only the one-line quotes)
git push --force-with-lease origin windows-local
```

The new `binaryResolution.ts` does not conflict; the most rebase-prone bits are the one-line
`quoteForWindowsShell(...)` wraps in the provider files.

## Building the Windows installer

`bun run dist:desktop:win` produces `release/Synara-<version>-x64.exe`. On Windows (esp. in
China) three things were needed beyond the defaults:

1. **MSVC C++ toolchain** — install "Visual Studio Build Tools" with the *Desktop development
   with C++* workload (node-gyp needs MSVC; GCC won't do). One-time.
2. **China mirrors** for the Electron/NSIS binary downloads (GitHub stalls otherwise).
3. **Skip the native rebuild** — node-pty 1.1.0 ships N-API prebuilds that already work under
   Electron, and `@electron/rebuild` otherwise fails recompiling winpty from the bun-staged
   copy (`'GetCommitHash.bat' is not recognized`). Pass `-c.npmRebuild=false`: add it to the
   `bunx electron-builder ...` line in `scripts/build-desktop-artifact.ts` (a transient local
   edit — don't commit it to this patch).

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
# in scripts/build-desktop-artifact.ts, change the electron-builder line to add -c.npmRebuild=false:
#   bunx electron-builder ${platformConfig.cliFlag} --${options.arch} -c.npmRebuild=false --publish never
bun run dist:desktop:win
# revert the script edit afterwards: git checkout -- scripts/build-desktop-artifact.ts
```

## Verify / caveats

- Checks: `bun typecheck`, `bun lint` (0 errors), and `oxfmt --check`.
- **Do NOT run `bun fmt`** on a Windows checkout with `autocrlf=true`: oxfmt rewrites the
  whole repo to LF (an EOL artifact). Git normalizes on commit, but the working tree goes
  noisy. Use `oxfmt --check` instead.
- Pre-existing Windows test failures unrelated to this patch: the codex home-overlay symlink
  tests (need Developer Mode / admin) and `CodexTextGeneration.test.ts` (spawns a POSIX
  agent script).
