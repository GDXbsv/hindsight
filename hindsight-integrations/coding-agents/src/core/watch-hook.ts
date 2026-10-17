/**
 * One run of the Claude Code memory watcher hook (see claude-watch-hook.ts and core/watch.ts):
 * read the transcript's new steps, judge the pending moment with one reflect, return the note.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { diag } from "./diag";
import type { HindsightClient } from "./hindsight";
import {
  CONFLICT_Q,
  HEADSUP_Q,
  acceptNote,
  bestSentence,
  emptyWatchState,
  readStep,
  readable,
  renderNote,
  searchQueries,
  shouldAsk,
  situation,
  stepsOf,
  type Moment,
  type WatchState,
} from "./watch";

const HARNESS = "claude-code";
/** A crashed or killed holder leaves its lock behind; past this age anyone may take it. */
const STALE_LOCK_MS = 5 * 60_000;
/** Moments one holder judges before leaving, so a busy session still gets its notes delivered. */
const MAX_ROUNDS = 3;
const REFLECT_TIMEOUT_MS = 60_000;

/** The client calls a run makes: one reflect per moment, and memory/document reads for the source. */
export type WatchClient = Pick<HindsightClient, "reflectMaybe" | "getMemory" | "documentText">;

export function sessionDir(root: string, sessionId: unknown): string {
  const dir = join(root, String(sessionId ?? "x").replace(/[^\w-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function tryLock(lock: string): boolean {
  try {
    closeSync(openSync(lock, "wx"));
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs < STALE_LOCK_MS) return false;
      rmSync(lock, { force: true });
      closeSync(openSync(lock, "wx"));
      return true;
    } catch {
      return false;
    }
  }
}

function loadState(file: string): WatchState {
  try {
    return {
      ...emptyWatchState(),
      ...(JSON.parse(readFileSync(file, "utf8")) as Partial<WatchState>),
    };
  } catch {
    return emptyWatchState();
  }
}

/** Read the transcript's new complete lines into the state; a half-written last line waits. */
function follow(transcript: string, state: WatchState): void {
  let buf: Buffer;
  try {
    buf = readFileSync(transcript);
  } catch {
    return;
  }
  const chunk = buf.subarray(state.offset);
  const end = chunk.lastIndexOf(0x0a);
  if (end < 0) return;
  state.offset += end + 1;
  for (const raw of chunk.subarray(0, end).toString("utf8").split("\n")) {
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (line && typeof line === "object")
      for (const step of stepsOf(line as Record<string, unknown>)) readStep(state, step);
  }
}

const git = (cwd: string, ...args: string[]): string => {
  try {
    // stderr captured: a hook's stray `fatal:` must not reach the host's terminal.
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8 << 20,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
};

/** The agent's change to the source: tracked edits plus new files (`git diff` alone skips those). */
export function sourceDiff(cwd: string): string {
  const spec = ["--", ".", ":(exclude)tests/**", ":(exclude)test/**", ":(exclude)**/*.test.*"];
  let out = git(cwd, "diff", "HEAD", ...spec);
  for (const f of git(cwd, "ls-files", "--others", "--exclude-standard", ...spec)
    .split("\n")
    .filter(Boolean)
    .slice(0, 20))
    out += git(cwd, "diff", "--no-index", "/dev/null", f);
  return out;
}

/** Where the agent can read a document. Commit ids are this repo's own, so git can show them. */
function whereFor(documentId: string, mentionedAt?: string | null): string {
  if (documentId.startsWith("git:")) return `git show ${documentId.slice(4, 16)}`;
  if (documentId.startsWith("gitlog:")) return "git log";
  if (documentId.startsWith("conversation:") || documentId.startsWith("chat:"))
    return `a past session${mentionedAt ? ` (${mentionedAt.slice(0, 10)})` : ""}`;
  return "project memory";
}

/** The note's source: the newest document behind the memory, and its closest sentence (verbatim). */
async function sourceOf(
  client: WatchClient,
  memoryId: string,
  note: string
): Promise<{ where: string; quote: string }> {
  const memory = await client.getMemory(memoryId);
  const sources = [];
  for (const id of (memory?.source_memory_ids ?? []).slice(0, 6)) {
    const m = await client.getMemory(id);
    if (m?.document_id) sources.push({ ...m, document_id: m.document_id });
  }
  sources.sort((a, b) => String(b.mentioned_at ?? "").localeCompare(String(a.mentioned_at ?? "")));
  for (const s of sources) {
    const quote = bestSentence(readable(await client.documentText(s.document_id)), note);
    if (quote) return { where: whereFor(s.document_id, s.mentioned_at), quote };
  }
  return {
    where: sources[0]
      ? whereFor(sources[0].document_id, sources[0].mentioned_at)
      : "project memory",
    quote: "",
  };
}

/**
 * Judge what the session did since the last run. Returns the note to deliver, or null. One run
 * holds the session's lock; overlapping runs return null at once (the holder reads their steps).
 */
export async function watchOnce(args: {
  transcriptPath: string;
  cwd: string;
  dir: string;
  client: WatchClient;
  diff?: (cwd: string) => string;
}): Promise<string | null> {
  const { transcriptPath, cwd, dir, client } = args;
  const diffOf = args.diff ?? sourceDiff;
  const lock = join(dir, "lock");
  const stateFile = join(dir, "state.json");
  if (!tryLock(lock)) return null;
  try {
    const state = loadState(stateFile);
    for (let round = 0; round < MAX_ROUNDS; round++) {
      follow(transcriptPath, state);
      const pending = state.pending;
      state.pending = null;
      if (!pending) break;
      const m: Moment = { ...pending, recent: [...state.recent], diff: diffOf(cwd) };
      if (!shouldAsk(state, m)) continue;
      writeFileSync(stateFile, JSON.stringify(state)); // judged before the slow call
      const t0 = Date.now();
      const answer = await client.reflectMaybe(m.trigger === "task" ? HEADSUP_Q : CONFLICT_Q, {
        context: situation(state.goal || m.text, m, state.sent),
        searchQueries: searchQueries(m),
        timeoutMs: REFLECT_TIMEOUT_MS,
      });
      if (!answer.supported) {
        // An older server ignores `abstain` and answers every moment: listening would be noise.
        state.unsupported = true;
        diag(HARNESS, "watch_unsupported", {});
        break;
      }
      const spoke = acceptNote(state, m, answer.text, answer.memoryIds);
      diag(HARNESS, "watch", { trigger: m.trigger, spoke, ms: Date.now() - t0 });
      if (!spoke) continue;
      const src = answer.memoryIds[0]
        ? await sourceOf(client, answer.memoryIds[0], answer.text)
        : { where: "project memory", quote: "" };
      writeFileSync(stateFile, JSON.stringify(state));
      return renderNote(answer.text, src.where, src.quote); // deliver now; the next run reads on
    }
    writeFileSync(stateFile, JSON.stringify(state));
    return null;
  } finally {
    rmSync(lock, { force: true });
  }
}
