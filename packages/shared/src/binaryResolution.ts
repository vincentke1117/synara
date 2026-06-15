// FILE: binaryResolution.ts
// Purpose: Locate provider CLI executables and enrich PATH so non-default Windows
//   installs (custom npm prefix, scoop/pnpm/bun/volta shims) are discoverable.
// Layer: Shared runtime utility (no Effect dependency — usable from raw child_process,
//   the Effect ChildProcessSpawner, and the Electron desktop process alike).
// Exports: resolveExecutablePath (PATHEXT-aware which), windowsCliBinDirs,
//   enrichWindowsPathForSpawn, enrichSpawnEnv.
// Depends on: shared shell helpers (registry env reader + PATH merge). Do NOT duplicate
//   the registry reading logic that already lives in shell.ts.
//
// Platform note: every helper takes an explicit `platform` so it is unit-testable on any
// host. We therefore select `path.win32`/`path.posix` from that platform rather than the
// ambient `path` (whose separator semantics follow the host OS).

import { readFileSync, statSync } from "node:fs";
import * as OS from "node:os";
import * as path from "node:path";

import {
  mergePathEntries,
  readWindowsPersistentEnvironment,
  type WindowsEnvironmentReader,
} from "./shell";

const WINDOWS_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export type FileExistsPredicate = (filePath: string) => boolean;
export type ReadTextFile = (filePath: string) => string | undefined;

function defaultFileExists(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function defaultReadTextFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function pathApiFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

// Windows environment variable names are case-insensitive, but a plain object spread from
// `process.env` keeps the OS casing (Node stores PATH as `Path` on Windows). Reading
// `env.PATH` off such an object misses the value, and writing `env.PATH = x` creates a
// duplicate `Path`/`PATH` pair the child then resolves unpredictably. These helpers look
// up and target the actual key.
function getEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) return env[key];
  }
  return undefined;
}

/** The existing case-insensitive `PATH` key on `env`, or `"PATH"` if none is present. */
export function pathEnvKey(env: NodeJS.ProcessEnv): string {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") return key;
  }
  return "PATH";
}

// PATHEXT is a `;`-separated list of executable suffixes (`.EXE`, `.CMD`, ...). Windows
// resolves a bare command name against PATH by appending each of these in turn. We mirror
// that so a npm-installed `codex` resolves to `codex.cmd` without relying on a shell.
function parsePathExt(rawPathExt: string | undefined): ReadonlyArray<string> {
  const source = trimNonEmpty(rawPathExt) ?? WINDOWS_DEFAULT_PATHEXT;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of source.split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const normalized = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result.length > 0 ? result : [".EXE"];
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

export interface ResolveExecutableOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly pathExt?: string;
  readonly extraDirs?: ReadonlyArray<string>;
  readonly fileExists?: FileExistsPredicate;
}

/**
 * PATHEXT-aware `which`. Returns the absolute path to an executable for `command`, or
 * `undefined` when it cannot be found.
 *
 * - An absolute/relative path (containing a separator) is checked directly; on Windows a
 *   missing extension is resolved against PATHEXT (so `...\codex` finds `...\codex.cmd`).
 * - A bare name is searched across `extraDirs` then PATH, appending PATHEXT on Windows.
 *
 * Resolution is intentionally side-effect free apart from `fileExists` (injectable for
 * tests) so it stays cross-platform testable.
 */
export function resolveExecutablePath(
  command: string,
  options: ResolveExecutableOptions = {},
): string | undefined {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) return undefined;

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? defaultFileExists;
  const isWindows = platform === "win32";
  const pathApi = pathApiFor(platform);
  const delimiter = isWindows ? ";" : ":";
  const extensions = isWindows
    ? parsePathExt(options.pathExt ?? getEnvValue(env, "PATHEXT"))
    : [""];

  const matchWithExtensions = (base: string): string | undefined => {
    if (fileExists(base)) return base;
    if (!isWindows) return undefined;
    // Only append an extension when the base does not already end in a known one.
    const lowerBase = base.toLowerCase();
    if (extensions.some((ext) => ext.length > 0 && lowerBase.endsWith(ext.toLowerCase()))) {
      return undefined;
    }
    for (const ext of extensions) {
      const candidate = `${base}${ext}`;
      if (fileExists(candidate)) return candidate;
    }
    return undefined;
  };

  if (pathApi.isAbsolute(trimmedCommand) || hasPathSeparator(trimmedCommand)) {
    return matchWithExtensions(trimmedCommand);
  }

  const pathDirs = (trimNonEmpty(getEnvValue(env, "PATH")) ?? "")
    .split(delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0);
  const searchDirs = [...(options.extraDirs ?? []), ...pathDirs];

  for (const dir of searchDirs) {
    const hit = matchWithExtensions(pathApi.join(dir, trimmedCommand));
    if (hit) return hit;
  }
  return undefined;
}

// Recover a user-configured npm global prefix without spawning `npm` (which is slow and
// itself PATH-dependent). npm writes `.cmd` shims directly into the prefix dir on Windows.
function readNpmPrefixFromNpmrc(
  homeDir: string,
  pathApi: path.PlatformPath,
  fileExists: FileExistsPredicate,
  readTextFile: ReadTextFile,
): string | undefined {
  const npmrcPath = pathApi.join(homeDir, ".npmrc");
  if (!fileExists(npmrcPath)) return undefined;
  const contents = readTextFile(npmrcPath);
  if (!contents) return undefined;
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*prefix\s*=\s*(.+?)\s*$/.exec(line);
    if (match) {
      return trimNonEmpty(match[1]?.replace(/^["']|["']$/g, ""));
    }
  }
  return undefined;
}

/**
 * Quote a command/argument for a Windows `cmd.exe` shell spawn (`shell: true`).
 *
 * Node concatenates the command and args into a single `cmd.exe` command line WITHOUT
 * escaping (the DEP0190 warning), so a `binaryPath` containing a space — e.g.
 * `C:\Program Files\...\codex.cmd` — is split at the space and fails. Wrapping it in
 * double quotes makes `cmd.exe` (with its `/s` handling) treat it as one token. This is
 * the only cross-runtime-safe fix: spawning a resolved `.cmd` with `shell:false` throws
 * EINVAL on modern Node, so we must keep `shell:true` and quote instead.
 *
 * Identity on non-Windows (POSIX spawns run with `shell:false` and pass args as an array,
 * which needs no quoting). Values without whitespace, or already quoted, are returned
 * unchanged so the common bare-command case is untouched.
 */
export function quoteForWindowsShell(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return value;
  if (!/\s/.test(value)) return value;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value;
  return `"${value}"`;
}

export interface WindowsCliBinDirsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly fileExists?: FileExistsPredicate;
  readonly readTextFile?: ReadTextFile;
}

/**
 * The ordered list of directories where coding-agent CLIs are commonly installed on
 * Windows, covering non-default install methods (custom npm prefix, scoop, pnpm, bun,
 * volta, the codex installer). Non-existent entries are harmless on PATH (resolution
 * stats specific files, it never scans these dirs), so we return all deduped candidates
 * deterministically rather than filtering on the filesystem. Empty on non-Windows.
 */
export function windowsCliBinDirs(options: WindowsCliBinDirsOptions = {}): ReadonlyArray<string> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return [];

  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? defaultFileExists;
  const readTextFile = options.readTextFile ?? defaultReadTextFile;
  const pathApi = pathApiFor(platform);
  const homeDir = trimNonEmpty(options.homeDir) ?? safeHomeDir();
  const appData = trimNonEmpty(getEnvValue(env, "APPDATA"));
  const localAppData = trimNonEmpty(getEnvValue(env, "LOCALAPPDATA"));

  const candidates: Array<string | undefined> = [
    // npm global prefix: env override, then ~/.npmrc, then the Windows default.
    trimNonEmpty(getEnvValue(env, "npm_config_prefix")) ?? trimNonEmpty(getEnvValue(env, "PREFIX")),
    homeDir ? readNpmPrefixFromNpmrc(homeDir, pathApi, fileExists, readTextFile) : undefined,
    appData ? pathApi.join(appData, "npm") : undefined,
    // Alternative package managers / version managers.
    homeDir ? pathApi.join(homeDir, ".bun", "bin") : undefined,
    localAppData ? pathApi.join(localAppData, "pnpm") : undefined,
    homeDir ? pathApi.join(homeDir, "scoop", "shims") : undefined,
    localAppData ? pathApi.join(localAppData, "Volta", "bin") : undefined,
    homeDir ? pathApi.join(homeDir, ".volta", "bin") : undefined,
    // codex standalone installer.
    homeDir ? pathApi.join(homeDir, ".codex", "bin") : undefined,
  ];

  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const candidate of candidates) {
    const dir = trimNonEmpty(candidate);
    if (!dir) continue;
    const key = dir.toLowerCase().replace(/[\\/]+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs;
}

function safeHomeDir(): string | undefined {
  try {
    return trimNonEmpty(OS.homedir());
  } catch {
    return undefined;
  }
}

// Memoize the registry read: readWindowsPersistentEnvironment spawns powershell.exe
// (~seconds) and must not run per provider launch.
let cachedRegistryPath: string | undefined | null = null;

export function resetWindowsRegistryPathCache(): void {
  cachedRegistryPath = null;
}

function readRegistryPath(reader: WindowsEnvironmentReader | undefined): string | undefined {
  if (reader) {
    try {
      return trimNonEmpty(reader().PATH);
    } catch {
      return undefined;
    }
  }
  if (cachedRegistryPath === null) {
    try {
      cachedRegistryPath = trimNonEmpty(readWindowsPersistentEnvironment().PATH);
    } catch {
      cachedRegistryPath = undefined;
    }
  }
  return cachedRegistryPath;
}

export interface EnrichWindowsPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly extraDirs?: ReadonlyArray<string>;
  readonly readWindowsEnvironment?: WindowsEnvironmentReader;
  readonly fileExists?: FileExistsPredicate;
  readonly readTextFile?: ReadTextFile;
}

/**
 * Compute a PATH value that makes Windows CLI installs discoverable regardless of launch
 * context. Keeps the inherited PATH order intact and APPENDS, as fallbacks, the persisted
 * registry PATH and the common CLI bin dirs (deduplicated, case-insensitively on win32).
 * Identity passthrough on non-Windows (login-shell enrichment is handled elsewhere).
 */
export function enrichWindowsPathForSpawn(
  inheritedPath: string | undefined,
  options: EnrichWindowsPathOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return inheritedPath;

  const registryPath = readRegistryPath(options.readWindowsEnvironment);
  const binDirs = windowsCliBinDirs({
    ...(options.env ? { env: options.env } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    platform,
    ...(options.fileExists ? { fileExists: options.fileExists } : {}),
    ...(options.readTextFile ? { readTextFile: options.readTextFile } : {}),
  });
  // Inherited PATH first (never shadow an entry the process already resolves); then the
  // registry PATH (so a GUI launch picks up persisted entries it never inherited) and the
  // common CLI bin dirs (so a non-default install that is on neither inherited nor
  // registry PATH still resolves).
  const fallback = [
    ...(registryPath ? [registryPath] : []),
    ...binDirs,
    ...(options.extraDirs ?? []),
  ]
    .filter((value) => value && value.trim().length > 0)
    .join(";");

  return mergePathEntries(inheritedPath, fallback || undefined, "win32") ?? inheritedPath;
}

export interface EnrichSpawnEnvOptions extends EnrichWindowsPathOptions {
  /** When set to an absolute/relative path, the binary's own directory is prepended. */
  readonly binaryPath?: string;
}

/**
 * Return a copy of `env` with an enriched PATH suitable for spawning a provider CLI on
 * Windows. No-op (returns the same reference) on non-Windows or when nothing changed.
 */
export function enrichSpawnEnv(
  env: NodeJS.ProcessEnv,
  options: EnrichSpawnEnvOptions = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return env;

  const pathApi = pathApiFor(platform);
  const extraDirs: string[] = [...(options.extraDirs ?? [])];
  const configuredBinary = trimNonEmpty(options.binaryPath);
  if (
    configuredBinary &&
    (pathApi.isAbsolute(configuredBinary) || hasPathSeparator(configuredBinary))
  ) {
    const resolved =
      resolveExecutablePath(configuredBinary, {
        env,
        platform,
        ...(options.fileExists ? { fileExists: options.fileExists } : {}),
      }) ?? configuredBinary;
    extraDirs.unshift(pathApi.dirname(resolved));
  }

  const currentPath = getEnvValue(env, "PATH");
  const enrichedPath = enrichWindowsPathForSpawn(currentPath, {
    platform,
    env,
    extraDirs,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.readWindowsEnvironment
      ? { readWindowsEnvironment: options.readWindowsEnvironment }
      : {}),
    ...(options.fileExists ? { fileExists: options.fileExists } : {}),
    ...(options.readTextFile ? { readTextFile: options.readTextFile } : {}),
  });

  if (!enrichedPath || enrichedPath === currentPath) return env;
  // Write back to the existing PATH key (e.g. `Path`) so we never create a duplicate.
  return { ...env, [pathEnvKey(env)]: enrichedPath };
}
