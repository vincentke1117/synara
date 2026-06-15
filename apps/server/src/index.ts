import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CliConfig, t3Cli } from "./main";
import { OpenLive } from "./open";
import { Command } from "effect/unstable/cli";
import { version } from "../package.json" with { type: "json" };
import { ServerLive } from "./effectServer";
import { NetService } from "@t3tools/shared/Net";
import { enrichWindowsPathForSpawn } from "@t3tools/shared/binaryResolution";
import { FetchHttpClient } from "effect/unstable/http";

// Make provider CLIs discoverable regardless of how the server was launched. On Windows a
// GUI/desktop-launched process inherits a (possibly stale) PATH that omits non-default
// install locations — a custom npm prefix, scoop/pnpm/bun/volta shims — so we enrich
// process.env.PATH once at boot from the persisted registry PATH and the common CLI bin
// dirs. Every downstream provider spawn (codex, claude, gemini, cursor, grok, opencode,
// kilo) inherits this enriched PATH. No-op on non-Windows. See packages/shared/src/
// binaryResolution.ts.
if (process.platform === "win32") {
  const enrichedPath = enrichWindowsPathForSpawn(process.env.PATH);
  if (enrichedPath && enrichedPath !== process.env.PATH) {
    process.env.PATH = enrichedPath;
  }
}

const RuntimeLayer = Layer.empty.pipe(
  Layer.provideMerge(CliConfig.layer),
  Layer.provideMerge(ServerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

Command.run(t3Cli, { version })
  .pipe(Effect.provide(RuntimeLayer))
  .pipe((program) => NodeRuntime.runMain(program as Effect.Effect<void, unknown, never>));
