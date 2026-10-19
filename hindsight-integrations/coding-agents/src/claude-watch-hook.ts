#!/usr/bin/env node
/** hindsight-claude-watch-hook — the memory watcher for Claude Code (see core/watch-entry.ts). */
import { runWatchHook } from "./core/watch-entry";
import { claudeEventsOf } from "./core/session-events";
import { stepsOf } from "./core/watch";

runWatchHook({
  harness: "claude-code",
  entry: "claude-watch-hook.js",
  stepsOf,
  eventsOf: claudeEventsOf,
});
