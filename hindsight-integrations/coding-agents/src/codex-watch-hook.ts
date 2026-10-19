#!/usr/bin/env node
/** hindsight-codex-watch-hook — the memory watcher for Codex (see core/watch-entry.ts). */
import { runWatchHook } from "./core/watch-entry";
import { codexEventsOf } from "./core/session-events";
import { codexStepsOf } from "./core/watch";

runWatchHook({
  harness: "codex",
  entry: "codex-watch-hook.js",
  stepsOf: codexStepsOf,
  eventsOf: codexEventsOf,
});
