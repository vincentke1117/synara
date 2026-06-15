import { describe, expect, it } from "vitest";

import {
  enrichSpawnEnv,
  enrichWindowsPathForSpawn,
  pathEnvKey,
  quoteForWindowsShell,
  resetWindowsRegistryPathCache,
  resolveExecutablePath,
  windowsCliBinDirs,
} from "./binaryResolution";

// All tests force `platform` and inject `fileExists`/`readTextFile`/`readWindowsEnvironment`
// so they are hermetic and run identically on Windows and POSIX CI hosts.

const existsIn = (paths: ReadonlyArray<string>) => {
  const set = new Set(paths.map((value) => value.toLowerCase()));
  return (filePath: string) => set.has(filePath.toLowerCase());
};

describe("resolveExecutablePath (win32)", () => {
  it("resolves a bare command to its .cmd shim via PATHEXT", () => {
    const resolved = resolveExecutablePath("codex", {
      platform: "win32",
      env: { PATH: "D:\\nodejs\\node_global;C:\\Windows\\System32" },
      fileExists: existsIn(["D:\\nodejs\\node_global\\codex.cmd"]),
    });
    // The PATHEXT entry casing (.CMD) is returned; Windows paths are case-insensitive.
    expect(resolved?.toLowerCase()).toBe("d:\\nodejs\\node_global\\codex.cmd");
  });

  it("returns undefined when the command is on no PATH dir", () => {
    expect(
      resolveExecutablePath("cursor-agent", {
        platform: "win32",
        env: { PATH: "C:\\Windows\\System32" },
        fileExists: existsIn([]),
      }),
    ).toBeUndefined();
  });

  it("appends PATHEXT to an extensionless absolute path", () => {
    expect(
      resolveExecutablePath("D:\\tools\\codex", {
        platform: "win32",
        env: { PATH: "" },
        fileExists: existsIn(["D:\\tools\\codex.cmd"]),
      })?.toLowerCase(),
    ).toBe("d:\\tools\\codex.cmd");
  });

  it("returns an absolute path that already has an extension as-is", () => {
    expect(
      resolveExecutablePath("D:\\tools\\codex.cmd", {
        platform: "win32",
        env: { PATH: "" },
        fileExists: existsIn(["D:\\tools\\codex.cmd"]),
      }),
    ).toBe("D:\\tools\\codex.cmd");
  });

  it("does not split a PATH directory that contains spaces", () => {
    expect(
      resolveExecutablePath("claude", {
        platform: "win32",
        env: { PATH: "C:\\Program Files\\nodejs;C:\\Windows" },
        fileExists: existsIn(["C:\\Program Files\\nodejs\\claude.cmd"]),
      })?.toLowerCase(),
    ).toBe("c:\\program files\\nodejs\\claude.cmd");
  });

  it("searches extraDirs before PATH", () => {
    expect(
      resolveExecutablePath("codex", {
        platform: "win32",
        env: { PATH: "C:\\Windows" },
        extraDirs: ["D:\\custom\\npm"],
        fileExists: existsIn(["D:\\custom\\npm\\codex.cmd", "C:\\Windows\\codex.cmd"]),
      })?.toLowerCase(),
    ).toBe("d:\\custom\\npm\\codex.cmd");
  });

  it("honors a custom PATHEXT ordering", () => {
    expect(
      resolveExecutablePath("codex", {
        platform: "win32",
        env: { PATH: "D:\\bin" },
        pathExt: ".EXE;.CMD",
        fileExists: existsIn(["D:\\bin\\codex.exe", "D:\\bin\\codex.cmd"]),
      })?.toLowerCase(),
    ).toBe("d:\\bin\\codex.exe");
  });
});

describe("resolveExecutablePath (posix)", () => {
  it("resolves an exact name on PATH without appending an extension", () => {
    expect(
      resolveExecutablePath("codex", {
        platform: "linux",
        env: { PATH: "/usr/local/bin:/usr/bin" },
        fileExists: existsIn(["/usr/local/bin/codex"]),
      }),
    ).toBe("/usr/local/bin/codex");
  });

  it("does not invent a .cmd on posix", () => {
    expect(
      resolveExecutablePath("codex", {
        platform: "linux",
        env: { PATH: "/usr/local/bin" },
        fileExists: existsIn(["/usr/local/bin/codex.cmd"]),
      }),
    ).toBeUndefined();
  });
});

describe("windowsCliBinDirs", () => {
  it("returns the non-default npm prefix parsed from ~/.npmrc", () => {
    const dirs = windowsCliBinDirs({
      platform: "win32",
      homeDir: "C:\\Users\\Vincent",
      env: {},
      fileExists: existsIn(["C:\\Users\\Vincent\\.npmrc"]),
      readTextFile: () =>
        "registry=https://registry.npmmirror.com\nprefix=D:\\nodejs\\node_modules\\npm\\node_global\n",
    });
    expect(dirs).toContain("D:\\nodejs\\node_modules\\npm\\node_global");
  });

  it("prefers npm_config_prefix and includes scoop/pnpm/bun/volta/codex dirs", () => {
    const dirs = windowsCliBinDirs({
      platform: "win32",
      homeDir: "C:\\Users\\V",
      env: {
        npm_config_prefix: "D:\\override\\npm",
        APPDATA: "C:\\Users\\V\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\V\\AppData\\Local",
      },
      fileExists: existsIn([]),
      readTextFile: () => undefined,
    });
    expect(dirs).toContain("D:\\override\\npm");
    expect(dirs).toContain("C:\\Users\\V\\AppData\\Roaming\\npm");
    expect(dirs).toContain("C:\\Users\\V\\.bun\\bin");
    expect(dirs).toContain("C:\\Users\\V\\AppData\\Local\\pnpm");
    expect(dirs).toContain("C:\\Users\\V\\scoop\\shims");
    expect(dirs).toContain("C:\\Users\\V\\.volta\\bin");
    expect(dirs).toContain("C:\\Users\\V\\.codex\\bin");
  });

  it("is empty on non-Windows", () => {
    expect(windowsCliBinDirs({ platform: "darwin", env: {} })).toEqual([]);
  });
});

describe("enrichWindowsPathForSpawn", () => {
  it("is an identity passthrough on non-Windows", () => {
    expect(enrichWindowsPathForSpawn("/usr/bin:/bin", { platform: "linux" })).toBe("/usr/bin:/bin");
  });

  it("appends the registry PATH and the npm prefix so a non-inherited install resolves", () => {
    const result = enrichWindowsPathForSpawn("C:\\Windows\\System32", {
      platform: "win32",
      homeDir: "C:\\Users\\Vincent",
      env: {},
      readWindowsEnvironment: () => ({ PATH: "C:\\Windows\\System32;D:\\reg\\dir" }),
      fileExists: existsIn(["C:\\Users\\Vincent\\.npmrc"]),
      readTextFile: () => "prefix=D:\\nodejs\\node_modules\\npm\\node_global\n",
    });
    const entries = (result ?? "").split(";");
    expect(entries[0]).toBe("C:\\Windows\\System32");
    expect(entries).toContain("D:\\reg\\dir");
    expect(entries).toContain("D:\\nodejs\\node_modules\\npm\\node_global");
  });

  it("deduplicates entries case-insensitively without reordering the inherited PATH", () => {
    const result = enrichWindowsPathForSpawn("C:\\Windows;D:\\NodeJS\\Node_Global", {
      platform: "win32",
      homeDir: "C:\\Users\\Vincent",
      env: {},
      readWindowsEnvironment: () => ({ PATH: "d:\\nodejs\\node_global" }),
      fileExists: existsIn([]),
      readTextFile: () => undefined,
    });
    const entries = (result ?? "").split(";");
    expect(entries[0]).toBe("C:\\Windows");
    expect(entries[1]).toBe("D:\\NodeJS\\Node_Global");
    const nodeGlobalCount = entries.filter(
      (e) => e.toLowerCase().replace(/\\$/, "") === "d:\\nodejs\\node_global",
    ).length;
    expect(nodeGlobalCount).toBe(1);
  });
});

describe("quoteForWindowsShell", () => {
  it("quotes a win32 command path that contains spaces", () => {
    expect(quoteForWindowsShell("C:\\Program Files\\x\\codex.cmd", "win32")).toBe(
      '"C:\\Program Files\\x\\codex.cmd"',
    );
  });

  it("leaves a space-free win32 command untouched", () => {
    expect(quoteForWindowsShell("codex", "win32")).toBe("codex");
    expect(quoteForWindowsShell("D:\\bin\\codex.cmd", "win32")).toBe("D:\\bin\\codex.cmd");
  });

  it("does not double-quote an already-quoted value", () => {
    expect(quoteForWindowsShell('"C:\\Program Files\\x\\codex.cmd"', "win32")).toBe(
      '"C:\\Program Files\\x\\codex.cmd"',
    );
  });

  it("is an identity on non-Windows even with spaces", () => {
    expect(quoteForWindowsShell("/opt/my tools/codex", "linux")).toBe("/opt/my tools/codex");
  });
});

describe("enrichSpawnEnv", () => {
  it("returns the same env reference on non-Windows", () => {
    const env = { PATH: "/usr/bin" };
    expect(enrichSpawnEnv(env, { platform: "linux" })).toBe(env);
  });

  it("prepends a custom absolute binary's own directory on win32", () => {
    const env = { PATH: "C:\\Windows" };
    const result = enrichSpawnEnv(env, {
      platform: "win32",
      env,
      binaryPath: "D:\\custom place\\bin\\codex.cmd",
      readWindowsEnvironment: () => ({}),
      fileExists: existsIn(["D:\\custom place\\bin\\codex.cmd"]),
      readTextFile: () => undefined,
    });
    expect(result).not.toBe(env);
    expect((result.PATH ?? "").split(";")).toContain("D:\\custom place\\bin");
  });

  it("does not throw and resets the registry cache cleanly", () => {
    expect(() => resetWindowsRegistryPathCache()).not.toThrow();
  });
});

describe("Windows PATH key casing (process.env stores `Path`, not `PATH`)", () => {
  it("pathEnvKey finds the actual `Path` key", () => {
    expect(pathEnvKey({ Path: "C:\\Windows" })).toBe("Path");
    expect(pathEnvKey({ PATH: "C:\\Windows" })).toBe("PATH");
    expect(pathEnvKey({ HOME: "x" })).toBe("PATH");
  });

  it("resolveExecutablePath reads PATH from a `Path`-keyed env", () => {
    expect(
      resolveExecutablePath("codex", {
        platform: "win32",
        env: { Path: "D:\\nodejs\\node_global" },
        fileExists: existsIn(["D:\\nodejs\\node_global\\codex.cmd"]),
      })?.toLowerCase(),
    ).toBe("d:\\nodejs\\node_global\\codex.cmd");
  });

  it("enrichSpawnEnv updates the existing `Path` key and never adds a duplicate `PATH`", () => {
    const env = { Path: "C:\\Windows", APPDATA: "C:\\Users\\V\\AppData\\Roaming" };
    const result = enrichSpawnEnv(env, {
      platform: "win32",
      env,
      readWindowsEnvironment: () => ({ PATH: "C:\\Windows;D:\\reg\\dir" }),
      readTextFile: () => undefined,
    });
    // The enriched value lands on `Path`, and no separate `PATH` key is introduced.
    expect(Object.keys(result).filter((k) => k.toLowerCase() === "path")).toEqual(["Path"]);
    expect(result.Path).toContain("D:\\reg\\dir");
    expect(result).not.toHaveProperty("PATH");
  });
});
