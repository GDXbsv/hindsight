/**
 * The memory watcher's hook (`autoInject: "watch"`, see core/watch.ts and core/watch-hook.ts), for
 * every harness with a PostToolUse hook that hands `additionalContext` to the model (Claude Code,
 * Codex; WATCH_HARNESSES in core/config.ts). Each harness's entry names itself and how to read its
 * transcript. A hook in two halves, so the agent never waits on memory:
 *
 *  - the hook itself (milliseconds): hand over a note an earlier review left, as `additionalContext`
 *    next to this tool result, then start this step's review in a detached background process;
 *  - the background process (`--work`): on a server with sessions, send the transcript's new lines
 *    to the session and stash the notes it returns (the watcher itself runs in Hindsight, see
 *    core/session-sync.ts); on an older server, read the new steps, ask reflect, and stash the note.
 *    Either way the next tool call (or prompt, or Stop) hands it over.
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
import { deriveBankIdOrSkip } from "./bank";
import { applyBankConfig, loadConfig, type Config } from "./config";
import { DAEMON_WAIT_RETAIN_MS, ensureDaemon } from "./daemon";
import { diag } from "./diag";
import { HindsightClient } from "./hindsight";
import { describeError } from "./log";
import { sessionRootDir, stashPendingContext, takePendingContext } from "./session-cache";
import type { EventsOf } from "./session-events";
import { sessionOptions, syncSession, type SyncResult } from "./session-sync";
import { sessionDir, watchOnce, type StepsOf } from "./watch-hook";

const EVENT_ENV = "HINDSIGHT_WATCH_EVENT";

export interface WatchHarness {
  harness: string;
  /** The built entry file, which the hook starts again detached for the review. */
  entry: string;
  /** The transcript as the client-side watcher's steps (servers without sessions). */
  stepsOf: StepsOf;
  /** The transcript as session events (servers with sessions). */
  eventsOf: EventsOf;
}

/** The watcher's entry file per harness: the prompt hook starts it too (see startWatchSync). */
export const WATCH_ENTRIES: Record<string, string> = {
  "claude-code": "claude-watch-hook.js",
  codex: "codex-watch-hook.js",
};

interface WatchEvent {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  /** The prompt being submitted, when the prompt hook started this sync. */
  prompt?: string;
}

/** Start this step's review without waiting for it: the review outlives the hook. */
function startReview(h: Pick<WatchHarness, "entry">, ev: WatchEvent): void {
  try {
    const self = join(dirname(fileURLToPath(import.meta.url)), h.entry);
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

/** The config this repo's session runs with, or null when it does not watch: the per-bank and
 *  per-path overrides apply, as in session start and the prompt hook, so a repo set to "reflect"
 *  (or outside `optInOnly`) gets neither the notes nor a detached review per tool call. */
export function watchConfig(h: WatchHarness, cwd: string): { cfg: Config; bankId: string } | null {
  const base = loadConfig({ harness: h.harness });
  const derived = deriveBankIdOrSkip(base, cwd, h.harness);
  if (derived === null) return null;
  const resolved = applyBankConfig(base, derived, cwd);
  return resolved.cfg.disabled || resolved.cfg.autoInject !== "watch" ? null : resolved;
}

/**
 * The prompt hook's part: send the request to the session at once, so the heads-up check starts
 * while the agent reads its first files instead of at its first tool call. Detached, like a review.
 */
export function startWatchSync(harness: string, ev: WatchEvent): void {
  const entry = WATCH_ENTRIES[harness];
  if (entry && ev.session_id) startReview({ entry }, ev);
}

/** The session's sync, or null when the server has no sessions (the client-side watcher runs). */
export async function syncWatchedSession(
  h: Pick<WatchHarness, "harness" | "eventsOf">,
  ev: WatchEvent,
  resolved: { cfg: Config; bankId: string },
  turnEnd = false
): Promise<SyncResult | null> {
  if (!ev.session_id) return null;
  const cwd = ev.cwd ?? process.cwd();
  const { cfg, bankId } = resolved;
  const r = await syncSession({
    sessionId: ev.session_id,
    transcriptPath: ev.transcript_path,
    cwd,
    dir: sessionDir(join(tmpdir(), "hindsight-watch"), ev.session_id),
    client: new HindsightClient({ apiUrl: cfg.apiUrl, apiToken: cfg.apiToken, bank: bankId }),
    eventsOf: h.eventsOf,
    options: sessionOptions({
      cfg,
      harness: h.harness,
      sessionId: ev.session_id,
      bankId,
      cwd,
      sessionRoot: sessionRootDir(h.harness, ev.session_id, cwd),
      title: ev.prompt,
    }),
    ...(ev.prompt ? { prompt: { text: ev.prompt, ts: new Date().toISOString() } } : {}),
    turnEnd,
  });
  return r.unsupported ? null : r;
}

/** The background half: send what the session did, and leave its notes for the next tool call. */
async function review(h: WatchHarness, ev: WatchEvent): Promise<void> {
  if (!ev.session_id) return;
  const cwd = ev.cwd ?? process.cwd();
  const resolved = watchConfig(h, cwd);
  if (!resolved) return;
  const { cfg, bankId } = resolved;
  await ensureDaemon(cfg, h.harness, { waitMs: DAEMON_WAIT_RETAIN_MS });
  const synced = await syncWatchedSession(h, ev, resolved);
  if (synced) {
    for (const note of synced.notes) stashPendingContext(`${h.harness}-watch`, ev.session_id, note);
    if (synced.notes.length) diag(h.harness, "watch_notes", { count: synced.notes.length });
    return;
  }
  // A server without sessions: the client-side watcher judges the moment itself.
  if (!ev.transcript_path) return;
  const note = await watchOnce({
    harness: h.harness,
    stepsOf: h.stepsOf,
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
  // The pending-note stash, apart from any context the session's other hooks defer.
  if (note) stashPendingContext(`${h.harness}-watch`, ev.session_id, note);
}

async function main(h: WatchHarness): Promise<string | null> {
  // Grok Build runs Claude Code's hooks too (its compatibility layer): not this session's agent.
  if (process.env.HINDSIGHT_DISABLE_HOOKS || process.env.GROK_HOOK_EVENT) return null;
  if (process.argv[2] === "--work") {
    await review(h, JSON.parse(process.env[EVENT_ENV] ?? "{}") as WatchEvent);
    return null;
  }
  const ev = JSON.parse(readFileSync(0, "utf8")) as WatchEvent;
  if (!ev.session_id || !watchConfig(h, ev.cwd ?? process.cwd())) return null;
  const note = takePendingContext(`${h.harness}-watch`, ev.session_id);
  if (note) diag(h.harness, "watch_delivered", { chars: note.length });
  startReview(h, { session_id: ev.session_id, transcript_path: ev.transcript_path, cwd: ev.cwd });
  return note ?? null;
}

export function runWatchHook(h: WatchHarness): void {
  main(h).then(
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
      diag(h.harness, "watch_error", { error: describeError(e) });
      process.exit(0);
    }
  );
}
