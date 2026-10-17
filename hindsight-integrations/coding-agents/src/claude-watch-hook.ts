#!/usr/bin/env node
/**
 * hindsight-claude-watch-hook — the memory watcher for Claude Code (`autoInject: "watch"`, see
 * core/watch.ts and core/watch-hook.ts). A PostToolUse hook in two halves, so the agent never
 * waits on memory:
 *
 *  - the hook itself (milliseconds): hand over a note an earlier review left, as `additionalContext`
 *    next to this tool result, then start this step's review in a detached background process;
 *  - the background process (`--work`): read the transcript's new steps, ask reflect, and stash the
 *    note for the next tool call to hand over.
 *
 * Claude Code's own background hooks were tried and do not fit: an `async` hook's context arrives
 * only with the user's next message (never mid-task in `claude -p`), and an `asyncRewake` one is
 * shown to the agent as "PostToolUse hook blocking error" — the framing under which an agent read a
 * real decision as an injection and refused it. A plain hook's `additionalContext` is the channel
 * the sde-bench watcher measured.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveBankIdOrSkip } from "./core/bank";
import { applyBankConfig, loadConfig } from "./core/config";
import { DAEMON_WAIT_RETAIN_MS, ensureDaemon } from "./core/daemon";
import { diag } from "./core/diag";
import { HindsightClient } from "./core/hindsight";
import { describeError } from "./core/log";
import { stashPendingContext, takePendingContext } from "./core/session-cache";
import { sessionDir, watchOnce } from "./core/watch-hook";

const HARNESS = "claude-code";
/** The pending-note stash, apart from any context the session's other hooks defer. */
const NOTES = "claude-code-watch";
const EVENT_ENV = "HINDSIGHT_WATCH_EVENT";

interface WatchEvent {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

/** Start this step's review without waiting for it: the review outlives the hook. */
function startReview(ev: WatchEvent): void {
  try {
    const self = join(dirname(fileURLToPath(import.meta.url)), "claude-watch-hook.js");
    const child = spawn(process.execPath, [self, "--work"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, [EVENT_ENV]: JSON.stringify(ev) },
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best-effort: a failed spawn must not touch the agent */
  }
}

/** The background half: judge what the session did, and leave a note for the next tool call. */
async function review(ev: WatchEvent): Promise<void> {
  if (!ev.transcript_path || !ev.session_id) return;
  const cwd = ev.cwd ?? process.cwd();
  const base = loadConfig({ harness: HARNESS });
  const derived = deriveBankIdOrSkip(base, cwd, HARNESS);
  if (derived === null) return;
  const { cfg, bankId } = applyBankConfig(base, derived, cwd);
  if (cfg.disabled) return;
  await ensureDaemon(cfg, HARNESS, { waitMs: DAEMON_WAIT_RETAIN_MS });
  const note = await watchOnce({
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
  if (note) stashPendingContext(NOTES, ev.session_id, note);
}

async function main(): Promise<string | null> {
  // Grok Build runs Claude Code's hooks too (its compatibility layer): not this session's agent.
  if (process.env.HINDSIGHT_DISABLE_HOOKS || process.env.GROK_HOOK_EVENT) return null;
  if (process.argv[2] === "--work") {
    await review(JSON.parse(process.env[EVENT_ENV] ?? "{}") as WatchEvent);
    return null;
  }
  const ev = JSON.parse(readFileSync(0, "utf8")) as WatchEvent;
  const cfg = loadConfig({ harness: HARNESS });
  if (cfg.disabled || cfg.autoInject !== "watch" || !ev.session_id) return null;
  const note = takePendingContext(NOTES, ev.session_id);
  if (note) diag(HARNESS, "watch_delivered", { chars: note.length });
  startReview({ session_id: ev.session_id, transcript_path: ev.transcript_path, cwd: ev.cwd });
  return note ?? null;
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
