import { describe, expect, it } from "vitest";
import {
  MAX_NOTES,
  NOTE_LEAD,
  acceptNote,
  bestSentence,
  codexStepsOf,
  emptyWatchState,
  queryFromDiff,
  readStep,
  readable,
  renderNote,
  searchQueries,
  shouldAsk,
  situation,
  stepsOf,
  type Moment,
} from "./watch";

const prompt = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const say = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});
const tool = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const result = (id: string, text: string, is_error = false) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error }] },
});

function feed(lines: Record<string, unknown>[]) {
  const state = emptyWatchState();
  for (const line of lines) for (const step of stepsOf(line)) readStep(state, step);
  return state;
}

const moment = (over: Partial<Moment>): Moment => ({
  trigger: "edit",
  text: "",
  recent: [],
  diff: "",
  ...over,
});

describe("reading the agent's transcript", () => {
  it("a new request is a task moment, and becomes the goal", () => {
    const state = feed([prompt("Fix parse_quantity so memory limits match the config.")]);
    expect(state.pending).toEqual({
      trigger: "task",
      text: "Fix parse_quantity so memory limits match the config.",
    });
    expect(state.goal).toContain("parse_quantity");
  });

  it("an edit is a moment once its result is back; a read is only a step", () => {
    const state = feed([
      tool("t1", "Read", { file_path: "units.py" }),
      result("t1", "file contents"),
      tool("t2", "Edit", { file_path: "units.py", old_string: "a", new_string: "b" }),
      result("t2", "ok"),
    ]);
    expect(state.pending?.trigger).toBe("edit");
    expect(state.recent).toEqual([
      "agent read: units.py",
      "agent edit: units.py",
      "agent edited units.py",
    ]);
  });

  it("read-only and test commands make no moment; a changing command does", () => {
    expect(feed([tool("t", "Bash", { command: "pytest -q tests/" })]).pending).toBeNull();
    expect(feed([tool("t", "Bash", { command: "git status" })]).pending).toBeNull();
    expect(feed([tool("t", "Bash", { command: "rm -rf build && make" })]).pending?.trigger).toBe(
      "command"
    );
  });

  it("a failing result is a failure moment, unless the sandbox is what failed", () => {
    const failing = feed([
      tool("t", "Bash", { command: "pytest" }),
      result("t", "2 failed, 3 passed"),
    ]);
    expect(failing.pending?.trigger).toBe("failure");
    const sandbox = feed([
      tool("t", "Bash", { command: "pytest" }),
      result("t", "pytest: command not found", true),
    ]);
    expect(sandbox.pending).toBeNull();
  });

  it("only a long statement is a plan", () => {
    expect(feed([say("Done.")]).pending).toBeNull();
    expect(
      feed([say("I'll switch every suffix to binary powers and keep bare numbers as raw bytes.")])
        .pending?.trigger
    ).toBe("plan");
  });

  it("the heaviest, latest moment wins while the watcher is busy", () => {
    const state = feed([
      tool("t", "Edit", { file_path: "a.py" }),
      result("t", "ok"),
      say("Now I will look at the rest of the parser module before going further."),
    ]);
    expect(state.pending?.trigger).toBe("edit");
  });

  it("our own note and system reminders are not new requests", () => {
    expect(feed([prompt(`${NOTE_LEAD} memory suffixes are binary.`)]).pending).toBeNull();
    expect(feed([prompt("<system-reminder>x</system-reminder>")]).pending).toBeNull();
  });

  it("subagent and meta lines are not the agent's", () => {
    expect(stepsOf({ ...prompt("do a thing"), isSidechain: true })).toEqual([]);
    expect(stepsOf({ ...prompt("do a thing"), isMeta: true })).toEqual([]);
  });
});

describe("reading a Codex rollout", () => {
  const done = (item: Record<string, unknown>) => ({
    type: "event_msg",
    payload: { type: "item_completed", item },
  });
  const codex = (lines: Record<string, unknown>[]) => {
    const state = emptyWatchState();
    for (const line of lines) for (const step of codexStepsOf(line)) readStep(state, step);
    return state;
  };
  const run = (id: string, script: string, exit_code = 0, out = "") =>
    done({
      type: "CommandExecution",
      id,
      command: ["/bin/zsh", "-lc", script],
      aggregated_output: out,
      exit_code,
    });

  it("the prompt is the UserMessage event, not the startup context sent as a user message", () => {
    const state = codex([
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md" }],
        },
      },
      done({ type: "UserMessage", content: [{ type: "text", text: "Fix parse_quantity." }] }),
    ]);
    expect(state.pending).toEqual({ trigger: "task", text: "Fix parse_quantity." });
  });

  it("a command is read as Bash, a file change as an edit, however the model called them", () => {
    expect(codex([run("c1", "rg parse_quantity")]).pending).toBeNull();
    expect(codex([run("c1", "rm -rf build")]).pending?.trigger).toBe("command");
    // A code-mode `exec` script's calls only show up broken apart in these events.
    const patched = codex([
      {
        type: "response_item",
        payload: { type: "custom_tool_call", name: "exec", input: "await tools.apply_patch(...)" },
      },
      done({
        type: "FileChange",
        id: "p1",
        changes: { "/w/units.py": { type: "update" } },
        status: "completed",
      }),
    ]);
    expect(patched.pending?.trigger).toBe("edit");
    expect(patched.recent).toContain("agent edited /w/units.py");
  });

  it("a failing test run is a failure moment", () => {
    expect(codex([run("t", "pytest", 1, "2 failed")]).pending?.trigger).toBe("failure");
  });

  it("the request keeps its turn when the agent's first plan arrives in the same read", () => {
    const state = codex([
      done({ type: "UserMessage", content: [{ type: "text", text: "Fix parse_quantity." }] }),
      done({
        type: "AgentMessage",
        content: [
          {
            type: "Text",
            text: "I'll check the parser's compatibility requirements and reproduce it.",
          },
        ],
      }),
    ]);
    expect(state.pending?.trigger).toBe("task");
  });
});

describe("what a moment searches", () => {
  it("a request: its sentences naming code first, then its paragraphs", () => {
    const text = [
      "You are a maintainer of this project. A regression was reported:",
      "Pods are OOM-killed after deploy. Fix parse_quantity so resources match the configs.",
      "Do NOT modify any test files.",
    ].join("\n\n");
    const queries = searchQueries(moment({ trigger: "task", text }));
    expect(queries[0]).toBe("Fix parse_quantity so resources match the configs.");
    expect(queries).toContain("You are a maintainer of this project. A regression was reported:");
    expect(queries.length).toBeLessThanOrEqual(8);
  });

  it("an edit: its diff in words", () => {
    const diff = [
      "+++ b/units.py",
      "@@ -1,2 +1,2 @@ def parse_quantity",
      "-K = 1000",
      "+K = 1024",
    ].join("\n");
    expect(searchQueries(moment({ diff }))).toEqual([queryFromDiff(diff)]);
    expect(queryFromDiff(diff)).toBe(
      "Change to units.py (def parse_quantity):\n-K = 1000\n+K = 1024"
    );
  });
});

describe("the watcher's rules", () => {
  it("the same situation is never judged twice", () => {
    const state = emptyWatchState();
    const m = moment({ diff: "+x" });
    expect(shouldAsk(state, m)).toBe(true);
    expect(shouldAsk(state, m)).toBe(false);
    expect(shouldAsk(state, moment({ diff: "+y" }))).toBe(true);
  });

  it(`stops after ${MAX_NOTES} notes, and on a server that cannot abstain`, () => {
    const state = emptyWatchState();
    state.sent = Array.from({ length: MAX_NOTES }, (_, i) => `note ${i}`);
    expect(shouldAsk(state, moment({ diff: "+z" }))).toBe(false);
    const old = emptyWatchState();
    old.unsupported = true;
    expect(shouldAsk(old, moment({ diff: "+z" }))).toBe(false);
  });

  it("never says the same memory twice, but a heads-up does not use it up", () => {
    const state = emptyWatchState();
    expect(
      acceptNote(state, moment({ trigger: "task", text: "go" }), "Before you change X: K=1024.", [
        "obs-1",
      ])
    ).toBe(true);
    expect(
      acceptNote(state, moment({ diff: "+K=1000" }), "You set K=1000; the rule is 1024.", ["obs-1"])
    ).toBe(true);
    expect(acceptNote(state, moment({ diff: "+K=999" }), "Again K must be 1024.", ["obs-1"])).toBe(
      false
    );
    expect(acceptNote(state, moment({ diff: "+x" }), "", ["obs-2"])).toBe(false);
  });

  it("the context carries the situation and what was already said", () => {
    const text = situation(
      "Fix units",
      moment({ trigger: "command", text: "make", recent: ["agent read: a.py"], diff: "+K" }),
      ["told once"]
    );
    expect(text).toContain("MY REQUEST:\nFix units");
    expect(text).toContain("WHAT I JUST DID (command):\nmake");
    expect(text).toContain("MY CODE CHANGE SO FAR:\n+K");
    expect(text).toContain("ALREADY TOLD ME:\ntold once");
  });
});

describe("the note's source", () => {
  it("quotes a stored chat by its words, not its JSON", () => {
    const doc = [
      JSON.stringify({
        role: "user",
        content: "Exactly: memory K/M/G/T as 1024 powers, disk M/G/T as 1000 powers.",
      }),
      JSON.stringify({ role: "assistant", content: "Okay." }),
    ].join("\n");
    expect(bestSentence(readable(doc), "memory suffixes are 1024 powers")).toBe(
      "Exactly: memory K/M/G/T as 1024 powers, disk M/G/T as 1000 powers."
    );
  });

  it("quotes the line with the note's value, not the old or a rejected one", () => {
    const chat = [
      "MAX_ATTEMPTS = int(os.environ.get('RETRY_MAX_ATTEMPTS', 10)) # Current setting",
      "+MAX_ATTEMPTS = int(os.environ.get('RETRY_MAX_ATTEMPTS', 5))",
      "+MAX_ATTEMPTS = int(os.environ.get('RETRY_MAX_ATTEMPTS', 7))",
    ].join("\n");
    expect(
      bestSentence(
        chat,
        "MAX_ATTEMPTS must be int(os.environ.get('RETRY_MAX_ATTEMPTS', 7)): 7 attempts, not 5 or 8."
      )
    ).toBe("+MAX_ATTEMPTS = int(os.environ.get('RETRY_MAX_ATTEMPTS', 7))");
  });

  it("renders the note, where to read it, and the quote", () => {
    expect(renderNote("K is 1024.", "git show abc", "memory as 1024")).toBe(
      `${NOTE_LEAD} K is 1024. Source: git show abc — "memory as 1024"`
    );
    expect(renderNote("K is 1024.", "project memory", "")).toBe(
      `${NOTE_LEAD} K is 1024. Source: project memory`
    );
  });
});
