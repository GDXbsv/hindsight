/**
 * The watcher as a Hindsight session (servers with `POST .../sessions/{id}/events`): the plugin only
 * streams the conversation and hands notes over. What a moment is, what the agent was already told,
 * the reflect question and saving the conversation into memory all happen on the server.
 *
 * One sync reads the transcript's new complete lines, sends them as session events (plus the
 * working tree's diff when a tool just ran and it changed), and returns the notes the server has
 * not handed out yet. Every step is safe to repeat: events carry ids from the transcript, so a line
 * sent twice is stored once, and the transcript offset only moves once the server took the batch.
 *
 * On a server without sessions the first sync answers `unsupported` and the caller falls back to
 * the client-side watcher (core/watch-hook.ts).
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DEFAULT_RETAIN_CONTEXT } from "./chat";
import type { Config } from "./config";
import { resolveRetainScopes, type HindsightClient } from "./hindsight";
import { buildRetainStamp } from "./retain-stamp";
import type {
  AppendResult,
  EventsOf,
  SessionEvent,
  SessionNote,
  SessionOptions,
} from "./session-events";
import { sleep } from "./util";
import { renderNote } from "./watch";
import { sourceDiff, whereFor } from "./watch-hook";

/** A crashed or killed holder leaves its lock behind; past this age anyone may take it. */
const STALE_LOCK_MS = 60_000;
/** How long a sync waits for another one to finish: the prompt and turn-end events it carries
 *  exist only in this process, so it waits rather than drop them. */
const LOCK_WAIT_MS = 5_000;
const APPEND_TIMEOUT_MS = 10_000;
/** Events per append: a long transcript read for the first time goes in a few requests. */
const BATCH = 200;

export type SessionClient = Pick<HindsightClient, "appendSession">;

/** What the plugin keeps per session between hooks. */
export interface SessionSyncState {
  /** Bytes of the transcript already sent. */
  offset: number;
  /** The last note handed to the hooks to deliver; sent back as `ack`. */
  ack: number;
  /** The working tree's diff last sent, by hash. */
  diffHash: string;
  /** Whether the session's options were sent (the first append creates the session). */
  opened: boolean;
  /** The server has no sessions: this session uses the client-side watcher. */
  unsupported: boolean;
  /** Prompts the prompt hook already sent, by hash, so the transcript's copy is not sent again. */
  prompts: string[];
}

export const emptySyncState = (): SessionSyncState => ({
  offset: 0,
  ack: 0,
  diffHash: "",
  opened: false,
  unsupported: false,
  prompts: [],
});

const hash = (s: string): string => createHash("sha1").update(s).digest("hex");
/** A prompt as both hooks see it: the prompt hook gets it trimmed, the transcript keeps its newline. */
const promptHash = (s: string): string => hash(s.trim());

function loadState(file: string): SessionSyncState {
  try {
    return {
      ...emptySyncState(),
      ...(JSON.parse(readFileSync(file, "utf8")) as Partial<SessionSyncState>),
    };
  } catch {
    return emptySyncState();
  }
}

/** Whether this session already found the server without sessions (read without the lock). */
export function sessionsUnsupported(dir: string): boolean {
  return loadState(join(dir, "session.json")).unsupported;
}

async function lock(path: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(path, "wx"));
      return true;
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS) {
          rmSync(path, { force: true });
          continue;
        }
      } catch {
        continue; // released between our two calls: try again at once
      }
      if (Date.now() >= deadline) return false;
      await sleep(50);
    }
  }
}

/** The transcript's new complete lines as events; a half-written last line waits for next time. */
function readNew(
  transcript: string | undefined,
  state: SessionSyncState,
  eventsOf: EventsOf
): { events: SessionEvent[]; offset: number } {
  if (!transcript) return { events: [], offset: state.offset };
  let buf: Buffer;
  try {
    buf = readFileSync(transcript);
  } catch {
    return { events: [], offset: state.offset };
  }
  // A transcript shorter than what was sent was replaced (a new file under the same path): start over;
  // ids from the lines themselves keep the server from storing what it already has.
  const from = buf.length < state.offset ? 0 : state.offset;
  const chunk = buf.subarray(from);
  const end = chunk.lastIndexOf(0x0a);
  if (end < 0) return { events: [], offset: from };
  const events: SessionEvent[] = [];
  let pos = from;
  for (const raw of chunk.subarray(0, end).toString("utf8").split("\n")) {
    const at = pos;
    pos += Buffer.byteLength(raw) + 1;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!line || typeof line !== "object") continue;
    for (const e of eventsOf(line as Record<string, unknown>, at)) {
      // The prompt hook sent this request already, under its own id.
      const sent =
        e.kind === "message" && e.role === "user"
          ? state.prompts.indexOf(promptHash(e.text ?? ""))
          : -1;
      if (sent >= 0) {
        state.prompts.splice(sent, 1);
        continue;
      }
      events.push(e);
    }
  }
  return { events, offset: from + end + 1 };
}

/** What the agent reads for a note: the note, then where its source is and the source's words. */
export function noteText(n: SessionNote): string {
  const src = n.source;
  return renderNote(
    n.text,
    src ? whereFor(src.document_id, src.mentioned_at) : "project memory",
    src?.quote ?? ""
  );
}

export interface SyncResult {
  /** Rendered notes to deliver, oldest first. */
  notes: string[];
  /** The server has no sessions. */
  unsupported: boolean;
  /** A check is queued or running: another note may still come. */
  checking: boolean;
}

/**
 * Send the session what happened since the last sync, and take the notes it has for the agent.
 * `extra` are events this hook knows and the transcript may not have yet: the prompt being
 * submitted (also recorded so its transcript copy is skipped), or the end of the turn.
 */
export async function syncSession(args: {
  sessionId: string;
  transcriptPath?: string;
  cwd: string;
  dir: string;
  client: SessionClient;
  eventsOf: EventsOf;
  options: SessionOptions;
  prompt?: { text: string; ts?: string };
  turnEnd?: boolean;
  diff?: (cwd: string) => string;
}): Promise<SyncResult> {
  const none: SyncResult = { notes: [], unsupported: false, checking: false };
  mkdirSync(args.dir, { recursive: true });
  const lockFile = join(args.dir, "session.lock");
  const stateFile = join(args.dir, "session.json");
  if (!(await lock(lockFile, LOCK_WAIT_MS))) return none;
  try {
    const state = loadState(stateFile);
    if (state.unsupported) return { ...none, unsupported: true };
    const read = readNew(args.transcriptPath, state, args.eventsOf);
    const events = read.events;
    if (args.prompt?.text.trim()) {
      const h = promptHash(args.prompt.text);
      state.prompts = [...state.prompts, h].slice(-20);
      events.push({
        id: `prompt:${h.slice(0, 16)}:${read.offset}`,
        role: "user",
        kind: "message",
        text: args.prompt.text,
        ...(args.prompt.ts ? { ts: args.prompt.ts } : {}),
      });
    }
    // The change so far rides along whenever a tool just ran and it moved: the server checks
    // an edit against the latest one.
    if (events.some((e) => e.kind === "tool_result")) {
      const diff = (args.diff ?? sourceDiff)(args.cwd);
      const h = hash(diff);
      if (h !== state.diffHash) {
        events.push({
          id: `diff:${h.slice(0, 16)}:${read.offset}`,
          role: "system",
          kind: "state",
          data: { diff },
        });
        state.diffHash = h;
      }
    }
    if (args.turnEnd)
      events.push({ id: `turn_end:${read.offset}`, role: "assistant", kind: "turn_end" });

    const notes: SessionNote[] = [];
    let checking = false;
    // At least one append, even with nothing new: it is also how notes written since are fetched.
    for (let i = 0; i === 0 || i < events.length; i += BATCH) {
      const r = await args.client.appendSession(
        args.sessionId,
        {
          events: events.slice(i, i + BATCH),
          ack: state.ack,
          ...(state.opened ? {} : { session: args.options }),
        },
        APPEND_TIMEOUT_MS
      );
      if (!r.supported) {
        state.unsupported = true;
        writeFileSync(stateFile, JSON.stringify(state));
        return { ...none, unsupported: true };
      }
      state.opened = true;
      checking = r.checking;
      for (const n of r.notes)
        if (n.seq > state.ack && !notes.some((x) => x.seq === n.seq)) notes.push(n);
    }
    // Sent: the transcript is read up to here. Handed over: the notes are this hook's to deliver.
    state.offset = read.offset;
    notes.sort((a, b) => a.seq - b.seq);
    if (notes.length) state.ack = notes[notes.length - 1].seq;
    writeFileSync(stateFile, JSON.stringify(state));
    return { notes: notes.map(noteText), unsupported: false, checking };
  } finally {
    rmSync(lockFile, { force: true });
  }
}

/**
 * The session as this plugin sets it up: the watcher on, and the conversation saved at the end of
 * each turn into the document the plugin has always written (`conversation:<session>`), with the
 * same tags, metadata, context and observation scopes — so a bank reads the same whether the
 * plugin or the session wrote it.
 */
export function sessionOptions(args: {
  cfg: Config;
  harness: string;
  sessionId: string;
  bankId: string;
  cwd: string;
  sessionRoot?: string;
  title?: string;
}): SessionOptions {
  const { cfg, harness, sessionId, bankId } = args;
  const stamp = buildRetainStamp(cfg, {
    directory: args.cwd,
    sessionRoot: args.sessionRoot,
    harness,
    bankId,
    sessionId,
  });
  const tags = [...new Set([...stamp.tags, "source:chat", `harness:${harness}`])];
  const documentId = `conversation:${sessionId}`;
  return {
    source: harness,
    ...(args.title ? { title: args.title.slice(0, 200) } : {}),
    document_id: documentId,
    watch: true,
    retain: cfg.retainSessions === false ? "off" : "turns",
    tags,
    metadata: {
      ...stamp.metadata,
      source: "chat",
      session_id: sessionId,
      ref_id: documentId,
      harness,
    },
    context: stamp.context ?? DEFAULT_RETAIN_CONTEXT,
    strategy: "conversation",
    observation_scopes: resolveRetainScopes(tags, cfg.observationScopes),
  };
}
