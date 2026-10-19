/**
 * Pure logic behind the Sessions view (components/session-detail.tsx): turning a
 * session's raw event log into the rows the 3-way conversation renders, and the
 * small rules around it (delivery, latency, the watcher's decision path, polling).
 *
 * Kept free of React so every rule here is unit-tested (tests/lib/session-timeline.test.ts).
 */
import type { SessionEvent, SessionSummary } from "@/lib/api";

type CheckOutcome = "note" | "silent" | "repeat" | "skipped" | "error";

export interface LlmCall {
  scope: string;
  duration_ms?: number | null;
  detail?: string | null;
}

/** A `check` entry: one watcher reflect (or a recorded skip) for one moment. */
export interface CheckPayload {
  trigger?: string;
  moment_seq?: number;
  moment?: string;
  outcome?: CheckOutcome;
  reason?: string | null;
  error?: string | null;
  ms?: number;
  question?: string;
  context?: string;
  search_queries?: string[];
  answer?: string;
  abstained?: boolean;
  memory_ids?: string[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  llm_calls?: LlmCall[];
}

interface NoteSource {
  document_id?: string | null;
  quote?: string | null;
  mentioned_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** A `note` entry: what Hindsight told the agent. */
interface NotePayload {
  text?: string;
  trigger?: string;
  check_seq?: number;
  memory_ids?: string[];
  source?: NoteSource | null;
}

interface SavePayload {
  from_seq?: number;
  to_seq?: number;
  turns?: number;
  document_id?: string;
  operation_id?: string;
}

/** Which family a tool belongs to: picks its icon and how loud its row is. */
export type ToolFamily = "edit" | "command" | "read" | "other";

export interface CheckRow {
  kind: "check";
  key: string;
  seq: number;
  event: SessionEvent;
  check: CheckPayload;
}

export type TimelineRow =
  | {
      kind: "message";
      key: string;
      seq: number;
      event: SessionEvent;
      role: "user" | "assistant" | "system";
      text: string;
      checks: CheckRow[];
    }
  | {
      kind: "tool";
      key: string;
      seq: number;
      /** The call, or null when only its result is known (a result logged without its call). */
      call: SessionEvent | null;
      result: SessionEvent | null;
      tool: string;
      target: string;
      family: ToolFamily;
      isError: boolean;
      checks: CheckRow[];
    }
  | {
      kind: "state";
      key: string;
      seq: number;
      event: SessionEvent;
      diff: string;
      checks: CheckRow[];
    }
  | { kind: "turn_end"; key: string; seq: number; event: SessionEvent; checks: CheckRow[] }
  | {
      kind: "note";
      key: string;
      seq: number;
      event: SessionEvent;
      note: NotePayload;
      checks: CheckRow[];
    }
  | {
      kind: "save";
      key: string;
      seq: number;
      event: SessionEvent;
      save: SavePayload;
      checks: CheckRow[];
    }
  /** A check whose moment is not in the log: rendered on its own, where it happened. */
  | (CheckRow & { checks: CheckRow[] })
  | { kind: "other"; key: string; seq: number; event: SessionEvent; checks: CheckRow[] };

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "apply_patch",
  "str_replace",
]);
const COMMAND_TOOLS = new Set(["bash", "shell", "exec_command", "local_shell", "run_terminal_cmd"]);
const READ_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "websearch",
  "webfetch",
  "todowrite",
  "view",
  "search",
  "read_file",
  "list_dir",
]);

function toolFamily(tool: string): ToolFamily {
  const t = tool.toLowerCase();
  if (EDIT_TOOLS.has(t)) return "edit";
  if (COMMAND_TOOLS.has(t)) return "command";
  if (READ_TOOLS.has(t)) return "read";
  return "other";
}

/** Keeps the end of a long path: `/work/flagcore/bucket.py` -> `flagcore/bucket.py`. */
function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : path;
}

/**
 * The one thing a tool call acts on, for its one-line summary:
 * `Edit flagcore/bucket.py`, `Bash pytest -q`, `Grep crc32`.
 */
export function toolTarget(input: unknown): string {
  if (!input || typeof input !== "object") return str(input);
  const i = input as Record<string, unknown>;
  const path = str(i.file_path) || str(i.path) || str(i.notebook_path);
  if (path) return shortPath(path);
  const command = Array.isArray(i.command) ? i.command.join(" ") : str(i.command) || str(i.cmd);
  // A multi-line command (`python3 -c "` + a script) reads as nothing by its first
  // line alone, so its lines are joined and the row truncates the result.
  if (command) return command.replace(/\s*\n\s*/g, " ⏎ ").trim();
  for (const k of ["pattern", "query", "url", "description", "prompt"]) {
    if (str(i[k])) return str(i[k]).split("\n")[0];
  }
  const first = Object.values(i).find((v) => typeof v === "string") as string | undefined;
  return first ? first.split("\n")[0] : "";
}

interface Timeline {
  rows: TimelineRow[];
  /** Row key for any seq it contains (a tool row holds its call's and its result's seq). */
  rowKeyBySeq: Map<number, string>;
  eventBySeq: Map<number, SessionEvent>;
}

/**
 * Folds the log into rows: a tool result joins its call (by `call_id`), and each
 * check is attached to the row of the moment that caused it (`moment_seq`), so the
 * decision sits next to what it judged rather than wherever the reflect finished.
 */
export function buildTimeline(events: SessionEvent[]): Timeline {
  const rows: TimelineRow[] = [];
  const rowKeyBySeq = new Map<number, string>();
  const eventBySeq = new Map<number, SessionEvent>();
  const rowByKey = new Map<string, TimelineRow>();
  const toolByCallId = new Map<string, Extract<TimelineRow, { kind: "tool" }>>();

  const push = (row: TimelineRow) => {
    rows.push(row);
    rowByKey.set(row.key, row);
    rowKeyBySeq.set(row.seq, row.key);
  };

  for (const ev of events) {
    eventBySeq.set(ev.seq, ev);
    const p = ev.payload;
    const key = `e${ev.seq}`;

    if (ev.source === "hindsight") {
      if (ev.kind === "check") {
        const check: CheckRow = {
          kind: "check",
          key,
          seq: ev.seq,
          event: ev,
          check: p as CheckPayload,
        };
        const momentKey =
          typeof check.check.moment_seq === "number"
            ? rowKeyBySeq.get(check.check.moment_seq)
            : undefined;
        const host = momentKey ? rowByKey.get(momentKey) : undefined;
        if (host) {
          host.checks.push(check);
          rowKeyBySeq.set(ev.seq, host.key);
        } else {
          push({ ...check, checks: [] });
        }
      } else if (ev.kind === "note") {
        push({ kind: "note", key, seq: ev.seq, event: ev, note: p as NotePayload, checks: [] });
      } else if (ev.kind === "save") {
        push({ kind: "save", key, seq: ev.seq, event: ev, save: p as SavePayload, checks: [] });
      } else {
        push({ kind: "other", key, seq: ev.seq, event: ev, checks: [] });
      }
      continue;
    }

    if (ev.kind === "tool_call" || ev.kind === "tool_result") {
      const callId = str(p.call_id);
      const existing = callId ? toolByCallId.get(callId) : undefined;
      const isError = p.is_error === true;
      if (existing) {
        if (ev.kind === "tool_call") {
          existing.call = ev;
          existing.tool = str(p.tool) || existing.tool;
          existing.target = toolTarget(p.input);
          existing.family = toolFamily(existing.tool);
        } else {
          existing.result = ev;
        }
        existing.isError = existing.isError || isError;
        rowKeyBySeq.set(ev.seq, existing.key);
        continue;
      }
      const tool = str(p.tool);
      const row: Extract<TimelineRow, { kind: "tool" }> = {
        kind: "tool",
        key,
        seq: ev.seq,
        call: ev.kind === "tool_call" ? ev : null,
        result: ev.kind === "tool_result" ? ev : null,
        tool,
        target: ev.kind === "tool_call" ? toolTarget(p.input) : "",
        family: toolFamily(tool),
        isError,
        checks: [],
      };
      if (callId) toolByCallId.set(callId, row);
      push(row);
    } else if (ev.kind === "message") {
      const role = p.role === "user" || p.role === "system" ? p.role : "assistant";
      push({ kind: "message", key, seq: ev.seq, event: ev, role, text: str(p.text), checks: [] });
    } else if (ev.kind === "state") {
      const data = (p.data ?? {}) as Record<string, unknown>;
      push({ kind: "state", key, seq: ev.seq, event: ev, diff: str(data.diff), checks: [] });
    } else if (ev.kind === "turn_end") {
      push({ kind: "turn_end", key, seq: ev.seq, event: ev, checks: [] });
    } else {
      push({ kind: "other", key, seq: ev.seq, event: ev, checks: [] });
    }
  }
  return { rows, rowKeyBySeq, eventBySeq };
}

/** Checks that found nothing to say (or never ran): kept quiet, hidden by the "silent checks" toggle. */
export function isQuietCheck(check: CheckPayload): boolean {
  return check.outcome === "silent" || check.outcome === "skipped";
}

export function isDelivered(noteSeq: number, ackedSeq: number): boolean {
  return noteSeq <= ackedSeq;
}

/**
 * How long the agent waited for a note: from the moment's event being logged to the
 * note being written. Null when the chain (note -> check -> moment) is not in the log.
 */
export function noteLatencyMs(
  note: SessionEvent,
  eventBySeq: Map<number, SessionEvent>
): number | null {
  const checkSeq = (note.payload as NotePayload).check_seq;
  const check = typeof checkSeq === "number" ? eventBySeq.get(checkSeq) : undefined;
  const momentSeq = check ? (check.payload as CheckPayload).moment_seq : undefined;
  const moment = typeof momentSeq === "number" ? eventBySeq.get(momentSeq) : undefined;
  if (!moment) return null;
  return Math.max(0, Date.parse(note.created_at) - Date.parse(moment.created_at));
}

/**
 * Where the watcher's decision model sent the check (see reflect/agent.py,
 * `_pick_round`): stay silent without an LLM, let a writer word the answer, or let
 * the reflect LLM judge.
 */
export type DecisionRoute = "silent" | "nothing" | "writer" | "llm" | "unknown";

interface DecisionPick {
  /** The decision model's probability that no evidence answers. */
  none: number | null;
  kept: number | null;
  offered: number | null;
  route: DecisionRoute;
  ms: number | null;
}

interface DecisionPath {
  pick: DecisionPick | null;
  /** The LLM calls after the pick (e.g. `abstain_answer`), in order. */
  after: LlmCall[];
}

/** Parses `none=0.02, kept 1 of 8 offered: settled: the writer words the answer` and its siblings. */
export function parseDecisionDetail(detail: string | null | undefined): Omit<DecisionPick, "ms"> {
  const d = detail ?? "";
  const num = (re: RegExp) => {
    const m = d.match(re);
    return m ? Number(m[1]) : null;
  };
  const route: DecisionRoute = d.startsWith("nothing found")
    ? "nothing"
    : d.includes("silent, no LLM")
      ? "silent"
      : d.includes("settled")
        ? "writer"
        : d.includes("unsure")
          ? "llm"
          : "unknown";
  return {
    none: num(/none=([\d.]+)/),
    kept: num(/kept (\d+) of/),
    offered: num(/of (\d+) offered/),
    route,
  };
}

export function decisionPath(calls: LlmCall[] | undefined): DecisionPath {
  const list = calls ?? [];
  const i = list.findIndex((c) => c.scope === "decision_pick");
  if (i < 0) return { pick: null, after: list };
  const c = list[i];
  return {
    pick: { ...parseDecisionDetail(c.detail), ms: c.duration_ms ?? null },
    after: list.filter((_, j) => j !== i),
  };
}

/** Open and logged something in the last two minutes: shown with a pulsing LIVE marker. */
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;

export function isActive(session: Pick<SessionSummary, "status" | "last_event_at">, now: number) {
  if (session.status !== "open" || !session.last_event_at) return false;
  return now - Date.parse(session.last_event_at) < ACTIVE_WINDOW_MS;
}

/**
 * How long to wait before the next `events?after=` poll, or null to stop.
 *
 * Fast (1s) while something is happening, slower once the session has gone quiet,
 * slow while the tab is hidden. A closed session with no check in flight stops
 * after a poll that brought nothing new: the watcher can still finish a check, or
 * a save, right after close, so stopping on the first closed answer would miss it.
 */
export function nextPollDelay(opts: {
  visible: boolean;
  status: "open" | "closed";
  checking: boolean;
  gotNew: boolean;
  idleMs: number;
}): number | null {
  if (opts.status === "closed" && !opts.checking && !opts.gotNew) return null;
  if (!opts.visible) return 15_000;
  if (opts.checking || opts.gotNew || opts.idleMs < 60_000) return 1_000;
  if (opts.idleMs < 10 * 60_000) return 3_000;
  return 10_000;
}

export interface RowFilters {
  tools: boolean;
  silent: boolean;
  hindsightOnly: boolean;
  query: string;
}

function rowText(row: TimelineRow): string {
  switch (row.kind) {
    case "message":
      return row.text;
    case "tool":
      return [
        row.tool,
        row.target,
        JSON.stringify(row.call?.payload.input ?? ""),
        str(row.result?.payload.text),
      ].join("\n");
    case "state":
      return row.diff;
    case "note":
      return [row.note.text, row.note.source?.quote].join("\n");
    case "check":
      return checkText(row.check);
    default:
      return "";
  }
}

function checkText(c: CheckPayload): string {
  return [c.moment, c.answer, c.reason, c.error, ...(c.search_queries ?? [])].join("\n");
}

/**
 * Applies the view toggles. A row that hosts a visible check is kept even when its
 * own kind is filtered out, so hiding tool calls never hides the decision made on one.
 */
export function filterRows(rows: TimelineRow[], f: RowFilters): TimelineRow[] {
  const q = f.query.trim().toLowerCase();
  const out: TimelineRow[] = [];
  for (const row of rows) {
    const checks = f.silent ? row.checks : row.checks.filter((c) => !isQuietCheck(c.check));
    if (row.kind === "check" && !f.silent && isQuietCheck(row.check)) continue;
    const hindsight = row.kind === "note" || row.kind === "save" || row.kind === "check";
    const own = f.hindsightOnly
      ? hindsight
      : f.tools || (row.kind !== "tool" && row.kind !== "state");
    if (!own && checks.length === 0) continue;
    if (
      q &&
      !rowText(row).toLowerCase().includes(q) &&
      !checks.some((c) => checkText(c.check).toLowerCase().includes(q))
    ) {
      continue;
    }
    out.push(checks === row.checks ? row : { ...row, checks });
  }
  return out;
}

/**
 * Replay clock: each event's offset from the first, in ms, with dead gaps capped.
 *
 * ponytail: gaps longer than `maxGapMs` are squashed to it so a session that sat
 * idle for an hour still replays in minutes; replaying "real pace" across idle
 * periods would need a skip control instead.
 */
export function replayOffsets(events: SessionEvent[], maxGapMs = 10_000): number[] {
  const out: number[] = [];
  let t = 0;
  for (let i = 0; i < events.length; i++) {
    if (i > 0) {
      const gap = Date.parse(events[i].created_at) - Date.parse(events[i - 1].created_at);
      t += Math.min(Math.max(0, gap), maxGapMs);
    }
    out.push(t);
  }
  return out;
}

/** "1.2s", "850ms", "2m 05s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** "3 minutes ago" in the viewer's locale (lib/relative-time.ts is English-only). */
export function relativeTime(dateStr: string, locale: string, now = Date.now()): string {
  const sec = Math.round((Date.parse(dateStr) - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(sec);
  if (abs < 60) return rtf.format(sec, "second");
  if (abs < 3600) return rtf.format(Math.round(sec / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(sec / 3600), "hour");
  return rtf.format(Math.round(sec / 86_400), "day");
}
