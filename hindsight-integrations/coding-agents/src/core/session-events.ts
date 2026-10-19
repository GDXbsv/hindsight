/**
 * A harness transcript line as Hindsight session events (POST .../sessions/{id}/events): what was
 * said, the tools called, what they returned. Each event carries an id derived from the transcript
 * itself (the line's uuid, or its byte offset), so a line sent twice — a retry, two hooks reading
 * the same tail — is stored once by the server.
 *
 * Text is kept whole, unlike the watcher's own steps (core/watch.ts clips for its questions): the
 * session saves the conversation into memory from these events, so a cut message would be a lost
 * one. Tool output is the exception — it is only read to spot failures, and is never saved.
 */
import { stripInjectedMemory } from "./transcript-util";

export type SessionEventRole = "user" | "assistant" | "tool" | "system";
export type SessionEventKind = "message" | "tool_call" | "tool_result" | "state" | "turn_end";

export interface SessionEvent {
  id: string;
  role: SessionEventRole;
  kind: SessionEventKind;
  text?: string;
  tool?: string;
  call_id?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
  data?: Record<string, unknown>;
  ts?: string;
}

/** How the session is set up (sent with the first append; see the server's SessionOptions). */
export interface SessionOptions {
  title?: string;
  source?: string;
  document_id?: string;
  watch?: boolean;
  retain?: "turns" | "close" | "off";
  tags?: string[];
  metadata?: Record<string, string>;
  context?: string;
  strategy?: string;
  observation_scopes?: unknown;
}

export interface SessionNote {
  seq: number;
  text: string;
  trigger: string;
  memory_ids: string[];
  source?: { document_id: string; quote?: string; mentioned_at?: string | null } | null;
}

export type AppendResult =
  | { supported: true; notes: SessionNote[]; checking: boolean; lastSeq: number }
  | { supported: false };

/** One transcript line, and where it starts in the file (the id when the line has none). */
export type EventsOf = (line: Record<string, unknown>, offset: number) => SessionEvent[];

const MESSAGE_CAP = 50_000;
const RESULT_CAP = 8_000;
/** Tool inputs keep every key; a long value (a file a Write creates) is cut, it is never saved. */
const INPUT_VALUE_CAP = 2_000;

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

function compactInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>))
    out[k] = typeof v === "string" ? cap(v, INPUT_VALUE_CAP) : v;
  return out;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? (content as Record<string, unknown>[])
          .map((c) => (typeof c?.text === "string" ? c.text : ""))
          .filter(Boolean)
          .join("\n")
      : "";

/** Claude Code: user prompts, assistant text and tool calls, tool results. Meta lines, subagents'
 *  lines and compaction summaries are not the conversation. */
export const claudeEventsOf: EventsOf = (line, offset) => {
  if (line.isMeta === true || line.isSidechain === true || line.isCompactSummary === true)
    return [];
  const msg = line.message as { content?: unknown } | undefined;
  const content = msg && typeof msg === "object" ? msg.content : undefined;
  const base = typeof line.uuid === "string" && line.uuid ? line.uuid : `o${offset}`;
  const ts = typeof line.timestamp === "string" ? line.timestamp : undefined;
  const out: SessionEvent[] = [];
  const push = (e: Omit<SessionEvent, "id" | "ts">) =>
    out.push({ id: `${base}:${out.length}`, ...e, ...(ts ? { ts } : {}) });
  if (line.type === "assistant" && Array.isArray(content)) {
    for (const b of content as Record<string, unknown>[]) {
      if (b.type === "text" && typeof b.text === "string" && b.text.trim())
        push({
          role: "assistant",
          kind: "message",
          text: cap(stripInjectedMemory(b.text), MESSAGE_CAP),
        });
      else if (b.type === "tool_use")
        push({
          role: "assistant",
          kind: "tool_call",
          tool: String(b.name ?? ""),
          call_id: String(b.id ?? ""),
          input: compactInput(b.input),
        });
    }
  } else if (line.type === "user") {
    if (typeof content === "string" && content.trim())
      push({ role: "user", kind: "message", text: cap(stripInjectedMemory(content), MESSAGE_CAP) });
    for (const b of Array.isArray(content) ? (content as Record<string, unknown>[]) : []) {
      if (b.type === "text" && typeof b.text === "string" && b.text.trim())
        push({
          role: "user",
          kind: "message",
          text: cap(stripInjectedMemory(b.text), MESSAGE_CAP),
        });
      else if (b.type === "tool_result")
        push({
          role: "tool",
          kind: "tool_result",
          call_id: String(b.tool_use_id ?? ""),
          text: cap(textOf(b.content), RESULT_CAP),
          ...(b.is_error === true ? { is_error: true } : {}),
        });
    }
  }
  return out;
};

/** `["/bin/zsh", "-lc", script]` → script; a `cmd` string is already one. */
function codexCommand(item: Record<string, unknown>): string {
  const c = item.cmd ?? item.command;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.length === 3 && /^-[a-z]*c$/.test(String(c[1])) ? String(c[2]) : c.join(" ");
}

/** Codex: the finished items of its rollout (prompt, agent message, shell command, file change),
 *  read as Claude's Bash and Edit so the watcher judges both with one set of rules. */
export const codexEventsOf: EventsOf = (line, offset) => {
  const p = (line.payload ?? {}) as Record<string, unknown>;
  if (line.type !== "event_msg" || p.type !== "item_completed") return [];
  const item = (p.item ?? {}) as Record<string, unknown>;
  const callId = String(item.id ?? `o${offset}`);
  const base = `${callId}@${offset}`;
  const ts = typeof line.timestamp === "string" ? line.timestamp : undefined;
  const ev = (i: number, e: Omit<SessionEvent, "id" | "ts">): SessionEvent => ({
    id: `${base}:${i}`,
    ...e,
    ...(ts ? { ts } : {}),
  });
  switch (item.type) {
    case "UserMessage": {
      const said = textOf(item.content);
      return said.trim()
        ? [
            ev(0, {
              role: "user",
              kind: "message",
              text: cap(stripInjectedMemory(said), MESSAGE_CAP),
            }),
          ]
        : [];
    }
    case "AgentMessage": {
      const said = textOf(item.content);
      return said.trim()
        ? [ev(0, { role: "assistant", kind: "message", text: cap(said, MESSAGE_CAP) })]
        : [];
    }
    case "CommandExecution":
      return [
        ev(0, {
          role: "assistant",
          kind: "tool_call",
          tool: "Bash",
          call_id: callId,
          input: { command: codexCommand(item) },
        }),
        ev(1, {
          role: "tool",
          kind: "tool_result",
          call_id: callId,
          text: cap(String(item.aggregated_output ?? item.stdout ?? ""), RESULT_CAP),
          ...(item.exit_code !== undefined && Number(item.exit_code) !== 0
            ? { is_error: true }
            : {}),
        }),
      ];
    case "FileChange": {
      const files = Object.keys((item.changes ?? {}) as Record<string, unknown>);
      return [
        ev(0, {
          role: "assistant",
          kind: "tool_call",
          tool: "Edit",
          call_id: callId,
          input: { file_path: files.join(", ") },
        }),
        ev(1, {
          role: "tool",
          kind: "tool_result",
          call_id: callId,
          text: cap(String(item.stdout ?? ""), RESULT_CAP),
          ...(item.status === "failed" ? { is_error: true } : {}),
        }),
      ];
    }
    default:
      return [];
  }
};
