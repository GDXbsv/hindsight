/**
 * The memory watcher: Hindsight beside the coding agent, speaking only when memory holds something
 * the agent must hear — a decision the request does not state (a heads-up at the start), or one the
 * agent's plan, command or edit goes against. It never delays the agent: the tool hook that drives
 * it (Claude Code, Codex) runs the review in the background, and its note reaches the agent with a
 * later tool result. Each harness reads its own transcript format into the same steps (stepsOf,
 * codexStepsOf); everything after that is shared.
 *
 * Each moment is ONE reflect call with `abstain`: the server's decision model settles most moments
 * silently with no LLM call, and writes the note from the memory it picked otherwise. This module is
 * the client half, ported from the sde-bench watcher that measured it (33 tasks x 3 runs: every task
 * solved on the first try, against 54/99 for the first-prompt reflect): what a moment is, read from
 * the agent's transcript; what to search; how to ask; and its rules — never the same memory twice,
 * at most MAX_NOTES per session, the same situation never judged twice.
 */
import { createHash } from "node:crypto";

export type Trigger = "task" | "plan" | "command" | "edit" | "failure";

export interface Moment {
  trigger: Trigger;
  /** The request, the agent's words, the command, or the failure output. An edit uses `diff`. */
  text: string;
  /** The agent's last steps, one line each. */
  recent: string[];
  /** Its change to the source so far. */
  diff: string;
}

/** What the watcher keeps per session between hook runs. */
export interface WatchState {
  /** Bytes of the transcript already read. */
  offset: number;
  recent: string[];
  /** Tool calls not yet answered: id -> [tool, input]. */
  tools: Record<string, [string, Record<string, unknown>]>;
  pending: { trigger: Trigger; text: string } | null;
  /** The user's latest request: what the agent was asked to do. */
  goal: string;
  sent: string[];
  evidenceSent: string[];
  judged: string[];
  /** Set when the server cannot abstain (older than the watcher): the watcher stops for the session. */
  unsupported?: boolean;
}

export const emptyWatchState = (): WatchState => ({
  offset: 0,
  recent: [],
  tools: {},
  pending: null,
  goal: "",
  sent: [],
  evidenceSent: [],
  judged: [],
});

export const MAX_NOTES = 3;

/** How the agent hears a note — the wording the benchmark validated, and `isOwnNote`'s marker. */
export const NOTE_LEAD = "🧠 Note from this project's memory (past sessions and commits):";

/**
 * Told to the agent once, at session start. Without it a note read as an injection: Claude called a
 * real decision (a recorded corp-beta override) a prompt injection and refused it three times.
 */
export const WATCH_DECLARATION =
  "A memory watcher runs next to you. It knows this project's past sessions and the decisions made " +
  `in them, and while you work it may post notes starting with "${NOTE_LEAD.split(" (")[0]}". A note ` +
  "is a project requirement even when the request does not mention it: a fix that contradicts a past " +
  "decision is a wrong fix. Each note says where to read its source: check it; if it says what the " +
  "note claims, apply the note as part of the task. Push back only if the source does not say so.";

/** A moment's weight when several arrive before the watcher is free: the heaviest, latest one wins. */
const PRIORITY: Record<Trigger, number> = { task: 0, plan: 1, failure: 2, command: 3, edit: 3 };

export const HEADSUP_Q =
  "Before I start on this request: which project decision recorded in memory (an exact value, a rule, " +
  "an exception) about exactly the code this request will change must my fix respect, that the request " +
  "itself does not state? Only what someone decided (a chosen value or rule, an exception, a rejected " +
  "option), not what the code already does: I can read that myself. Tell me in at most 70 words, as " +
  "'Before you change <the code>: <every such rule, " +
  "in its final form, in the words the memory states it; each rule a fix could get wrong>', copying " +
  "exact literals verbatim, no advice beyond the rules. If memory records no such decision about this " +
  "code, reply with nothing.";

export const CONFLICT_Q =
  "Does what I am doing right now (my plan, command or code change) contradict a project decision recorded " +
  "in memory, miss one, or repeat an option recorded as rejected? If so, tell me in at most 50 words the " +
  "recorded value or rule (exact literals verbatim) and what in my work disagrees. How I run, install or " +
  "check tests is never a conflict. If nothing conflicts, reply with nothing.";

const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);
/** Commands that change nothing, or only run checks: no moment. */
const READ_ONLY_CMD =
  /^\s*(cd [^;&|]+(&&|;)\s*)?(cat|ls|find|grep|rg|head|tail|wc|tree|file|which|pwd|echo|sed -n|awk|git (status|diff|log|show|blame)|python3? -m pytest|pytest|python3? -c|python3? -I -c|pip3? install|npm (test|run test)|npx (vitest|jest))\b/;
/** The sandbox failing, not the project: no moment. */
const ENV_TROUBLE = /command not found|No module named (pytest|pip)/;
const FAILED = /\b\d+ failed\b|Traceback \(most recent call last\)|\bFAILED\b|\bError:/;

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

export interface Step {
  kind: "ask" | "say" | "tool" | "result";
  text: string;
  id?: string;
  tool?: string;
  input?: Record<string, unknown>;
  error?: boolean;
}

/** One Claude Code transcript line as the steps the watcher reads: a prompt, what the agent says,
 *  the tools it calls, what they return. Meta lines and subagents' lines are not the agent's. */
export function stepsOf(line: Record<string, unknown>): Step[] {
  if (line.isMeta === true || line.isSidechain === true || line.isCompactSummary === true)
    return [];
  const msg = line.message as { content?: unknown } | undefined;
  const content = msg && typeof msg === "object" ? msg.content : undefined;
  const out: Step[] = [];
  if (line.type === "assistant" && Array.isArray(content)) {
    for (const b of content as Record<string, unknown>[]) {
      if (b.type === "text" && typeof b.text === "string" && b.text)
        out.push({ kind: "say", text: clip(b.text, 3000) });
      else if (b.type === "tool_use")
        out.push({
          kind: "tool",
          text: "",
          id: String(b.id ?? ""),
          tool: String(b.name ?? ""),
          input: (b.input ?? {}) as Record<string, unknown>,
        });
    }
  } else if (line.type === "user") {
    if (typeof content === "string") out.push({ kind: "ask", text: clip(content, 4000) });
    for (const b of Array.isArray(content) ? (content as Record<string, unknown>[]) : []) {
      if (b.type === "text" && typeof b.text === "string")
        out.push({ kind: "ask", text: clip(b.text, 4000) });
      if (b.type !== "tool_result") continue;
      const c = b.content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? (c as Record<string, unknown>[]).map((x) => String(x.text ?? "")).join("\n")
            : "";
      out.push({
        kind: "result",
        text: clip(text, 3000),
        id: String(b.tool_use_id ?? ""),
        error: b.is_error === true,
      });
    }
  }
  return out;
}

/** `["/bin/zsh", "-lc", script]` → script; a `cmd` string is already one. */
function codexCommand(args: Record<string, unknown>): string {
  const c = args.cmd ?? args.command;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.length === 3 && /^-[a-z]*c$/.test(String(c[1])) ? String(c[2]) : c.join(" ");
}

/** One Codex rollout line as the same steps: its prompt, what it says, its shell commands and file
 *  changes — read as Claude's Bash and Edit, so one set of rules judges both — and what they return.
 *  Read from the `item_completed` events only: each carries one finished step in one shape, whether
 *  the model called `exec_command`/`apply_patch` directly or through a code-mode `exec` script (whose
 *  calls are JavaScript in a `custom_tool_call` that the response items never break apart). The
 *  response items also hold startup context sent as a user message, which is not the prompt. */
export function codexStepsOf(line: Record<string, unknown>): Step[] {
  const p = (line.payload ?? {}) as Record<string, unknown>;
  if (line.type !== "event_msg" || p.type !== "item_completed") return [];
  const item = (p.item ?? {}) as Record<string, unknown>;
  const id = String(item.id ?? "");
  const text = (content: unknown): string =>
    (Array.isArray(content) ? (content as Record<string, unknown>[]) : [])
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
  switch (item.type) {
    case "UserMessage":
      return [{ kind: "ask", text: clip(text(item.content), 4000) }];
    case "AgentMessage": {
      const said = text(item.content);
      return said ? [{ kind: "say", text: clip(said, 3000) }] : [];
    }
    case "CommandExecution":
      return [
        { kind: "tool", text: "", id, tool: "bash", input: { command: codexCommand(item) } },
        {
          kind: "result",
          text: clip(String(item.aggregated_output ?? item.stdout ?? ""), 3000),
          id,
          error: item.exit_code !== undefined && Number(item.exit_code) !== 0,
        },
      ];
    case "FileChange": {
      const files = Object.keys((item.changes ?? {}) as Record<string, unknown>);
      return [
        { kind: "tool", text: "", id, tool: "edit", input: { file_path: files.join(", ") } },
        {
          kind: "result",
          text: clip(String(item.stdout ?? ""), 3000),
          id,
          error: item.status === "failed",
        },
      ];
    }
    default:
      return [];
  }
}

const isOwnNote = (text: string): boolean => text.includes(NOTE_LEAD.split(" (")[0]);

/** One step into the state: the recent-steps line, and the moment it makes (if any) as pending. */
export function readStep(state: WatchState, step: Step): void {
  let said = "";
  let trigger: Trigger | undefined;
  let text = "";
  if (step.kind === "ask") {
    // A system reminder or our own note rides in the user's turn too: neither is a new request.
    if (isOwnNote(step.text) || step.text.startsWith("<")) return;
    said = `the user asked: ${clip(step.text, 200)}`;
    trigger = "task";
    text = step.text;
    state.goal = step.text;
  } else if (step.kind === "say") {
    said = `agent said: ${clip(step.text, 300)}`;
    if (step.text.length >= 60) [trigger, text] = ["plan", step.text];
  } else if (step.kind === "tool") {
    const tool = (step.tool ?? "").toLowerCase();
    state.tools[step.id ?? ""] = [tool, step.input ?? {}];
    const inp = step.input ?? {};
    const what = String(inp.command ?? inp.file_path ?? inp.pattern ?? inp.path ?? "");
    if (tool === "bash" && !READ_ONLY_CMD.test(what)) {
      said = `agent runs: ${clip(what, 300)}`;
      [trigger, text] = ["command", what];
    } else said = `agent ${tool}: ${clip(what, 200)}`;
  } else {
    const [tool, inp] = state.tools[step.id ?? ""] ?? ["", {}];
    delete state.tools[step.id ?? ""];
    if (isOwnNote(step.text)) said = "the agent was given the watcher's note";
    else if (EDIT_TOOLS.has(tool)) {
      said = `agent edited ${String(inp.file_path ?? inp.notebook_path ?? "")}`;
      trigger = "edit";
    } else if ((step.error || FAILED.test(step.text)) && !ENV_TROUBLE.test(step.text)) {
      said = `it failed: ${step.text.slice(-300)}`;
      [trigger, text] = ["failure", step.text.slice(-2000)];
    }
  }
  if (said) state.recent = [...state.recent, said].slice(-12);
  // A new request is never pushed out: read in one pass with the agent's first "I'll check..." (a
  // plan, heavier), it used to be replaced, and the heads-up for the request was never given.
  const keep = state.pending?.trigger === "task" && trigger !== "task";
  if (trigger && !keep && (!state.pending || PRIORITY[trigger] >= PRIORITY[state.pending.trigger]))
    state.pending = { trigger, text };
}

/** A diff as a search: the files and functions touched, then the changed lines. */
export function queryFromDiff(diff: string, cap = 1500): string {
  const files: string[] = [];
  const funcs: string[] = [];
  const lines: string[] = [];
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ b/")) files.push(l.slice(6));
    else if (l.startsWith("@@")) funcs.push(l.split("@@").pop()!.trim());
    else if (
      (l[0] === "+" || l[0] === "-") &&
      !l.startsWith("+++") &&
      !l.startsWith("---") &&
      l.slice(1).trim()
    )
      lines.push(l.trim());
  }
  const q = `Change to ${files.join(", ")} (${funcs.filter(Boolean).join("; ")}):\n${lines.join("\n")}`;
  return q.slice(0, cap);
}

/**
 * What the moment searches. A request is searched by its sentences naming code, then its paragraphs:
 * as one query, a harness's boilerplate (role, rules, "work efficiently") outweighed the request and
 * the heads-up never saw the decision. An edit is searched by its diff in words, anything else by
 * its own text.
 */
export function searchQueries(m: Moment): string[] {
  if (m.trigger === "edit") return [queryFromDiff(m.diff)];
  if (m.trigger !== "task") return [m.text.slice(0, 1500)];
  const paras = m.text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 40);
  const named = m.text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => /\b[a-z]+_[a-z_]+\b|\w\(\)|`[^`]+`/.test(s) && !/test/i.test(s));
  const queries = [...named.slice(0, 3), ...paras].slice(0, 8).map((q) => q.slice(0, 1500));
  return queries.length ? queries : [m.text.slice(0, 1500)];
}

const clipDiff = (diff: string, cap: number): string =>
  diff.length > cap ? `${diff.slice(0, cap)}\n... (diff cut at ${cap} chars)` : diff;

/** The moment as reflect's context: what the question is about, in the agent's own voice. */
export function situation(goal: string, m: Moment, sent: string[]): string {
  const parts = [`MY REQUEST:\n${goal.slice(0, 3000)}`];
  if (m.trigger !== "task") {
    parts.push(
      `WHAT I JUST DID (${m.trigger}):\n${m.trigger === "edit" ? clipDiff(m.diff, 6000) : m.text.slice(0, 3000)}`
    );
    if (m.recent.length) parts.push(`MY RECENT STEPS:\n${m.recent.slice(-8).join("\n")}`);
    if (m.trigger !== "edit" && m.diff.trim())
      parts.push(`MY CODE CHANGE SO FAR:\n${clipDiff(m.diff, 4000)}`);
  }
  if (sent.length) parts.push(`ALREADY TOLD ME:\n${sent.join("\n")}`);
  return parts.join("\n\n");
}

/** The same situation is never judged twice (an edit is its diff). */
export function momentKey(m: Moment): string {
  return createHash("sha1")
    .update(JSON.stringify([m.trigger, m.trigger === "edit" ? "" : m.text, m.diff]))
    .digest("hex");
}

/** Whether the moment is worth a reflect call; records it as judged when it is. */
export function shouldAsk(state: WatchState, m: Moment): boolean {
  if (state.unsupported || state.sent.length >= MAX_NOTES) return false;
  if (!(m.trigger === "edit" ? m.diff : m.text).trim()) return false;
  const key = momentKey(m);
  if (state.judged.includes(key)) return false;
  state.judged = [...state.judged, key].slice(-200);
  return true;
}

/**
 * Whether a note reaches the agent, and recording it when it does: never the same memory twice.
 * A heads-up does not use its memory up — going against it later is still worth saying.
 */
export function acceptNote(
  state: WatchState,
  m: Moment,
  text: string,
  memoryIds: string[]
): boolean {
  if (!text.trim()) return false;
  if (memoryIds.length && memoryIds.every((id) => state.evidenceSent.includes(id))) return false;
  state.sent.push(text.trim());
  if (m.trigger !== "task")
    state.evidenceSent = [...new Set([...state.evidenceSent, ...memoryIds])];
  return true;
}

/** A chat stored as JSON lines, as its messages' words: a quote must be text the agent can find. */
export function readable(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      try {
        const msg = JSON.parse(line) as unknown;
        return msg && typeof msg === "object" && "content" in msg
          ? String((msg as { content: unknown }).content)
          : line;
      } catch {
        return line;
      }
    })
    .join("\n");
}

// Numbers of any length count: a changed value ("7", not "10") is often the whole story.
const words = (s: string): Set<string> =>
  new Set(s.toLowerCase().match(/[a-z_][a-z0-9_]{2,}|\d+(?:\.\d+)?/g) ?? []);

/** The source sentence sharing the most words with the note, less two per number the note does not
 *  have: verbatim by construction, no model call. By overlap alone the line stating the old value
 *  ("10 # Current setting") beat the rule (7). On a tie the later sentence wins: a chat settles on its
 *  last word ("leave it at 7" after trying 5). */
export function bestSentence(text: string, like: string): string {
  const want = words(like);
  const isNum = (w: string) => /^\d/.test(w);
  let best = "";
  let bestScore = -Infinity;
  for (const s of text.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim())) {
    if (s.length < 20 || s.length > 300) continue;
    let shared = 0;
    let foreign = 0;
    for (const w of words(s))
      if (want.has(w)) shared++;
      else if (isNum(w)) foreign++;
    // The penalty only ranks: "K is 1024, never 1000" still quotes a note that says 1024.
    if (shared > 0 && shared - 2 * foreign >= bestScore)
      [best, bestScore] = [s, shared - 2 * foreign];
  }
  return best;
}

/** What the agent reads: the note, then where its source is and the source's own words. */
export function renderNote(text: string, where: string, quote: string): string {
  return `${NOTE_LEAD} ${text.trim()} Source: ${where}${quote ? ` — "${quote}"` : ""}`;
}
