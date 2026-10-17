#!/usr/bin/env node
/**
 * hindsight-claude-watch-hook — the memory watcher for Claude Code (`autoInject: "watch"`, see
 * core/watch.ts). Registered as an `async` PostToolUse hook: Claude Code starts it and goes on
 * without waiting, and the `additionalContext` it prints reaches Claude as a system reminder on the
 * next turn — so the agent never waits on memory.
 *
 * Each run reads the session transcript from where the last one stopped, exactly as the agent
 * wrote it: a new request (a heads-up is due), what the agent says, the commands it runs, its edits
 * and what failed (core/watch-hook.ts).
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveBankIdOrSkip } from "./core/bank";
import { applyBankConfig, loadConfig } from "./core/config";
import { DAEMON_WAIT_RETAIN_MS, ensureDaemon } from "./core/daemon";
import { diag } from "./core/diag";
import { HindsightClient } from "./core/hindsight";
import { describeError } from "./core/log";
import { sessionDir, watchOnce } from "./core/watch-hook";

const HARNESS = "claude-code";

async function main(): Promise<string | null> {
  // Grok Build runs Claude Code's hooks too (its compatibility layer): not this session's agent.
  if (process.env.HINDSIGHT_DISABLE_HOOKS || process.env.GROK_HOOK_EVENT) return null;
  const ev = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
  if (typeof ev.transcript_path !== "string") return null;
  const cwd = typeof ev.cwd === "string" ? ev.cwd : process.cwd();
  const base = loadConfig({ harness: HARNESS });
  if (base.disabled || base.autoInject !== "watch") return null;
  const derived = deriveBankIdOrSkip(base, cwd, HARNESS);
  if (derived === null) return null;
  const { cfg, bankId } = applyBankConfig(base, derived, cwd);
  if (cfg.disabled) return null;
  // In the background, like retain: waiting for a cold daemon delays no turn.
  await ensureDaemon(cfg, HARNESS, { waitMs: DAEMON_WAIT_RETAIN_MS });
  return watchOnce({
    transcriptPath: ev.transcript_path,
    cwd,
    dir: sessionDir(join(tmpdir(), "hindsight-watch"), ev.session_id),
    client: new HindsightClient({
      apiUrl: cfg.apiUrl,
      apiToken: cfg.apiToken,
      bank: bankId,
      observationScopes: cfg.observationScopes,
    }),
  });
}

main().then(
  (note) => {
    if (note)
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note },
        })
      );
    process.exit(0);
  },
  (e) => {
    // A watcher failure must never reach the agent: stay silent, leave a trail.
    diag(HARNESS, "watch_error", { error: describeError(e) });
    process.exit(0);
  }
);
