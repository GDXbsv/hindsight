import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { watchOnce, type WatchClient } from "./watch-hook";
import { CONFLICT_Q, HEADSUP_Q, NOTE_LEAD } from "./watch";

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const prompt = (text: string) => line({ type: "user", message: { role: "user", content: text } });
const edit = (id: string) =>
  line({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name: "Edit", input: { file_path: "units.py" } }],
    },
  }) +
  line({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  });

function session() {
  const root = mkdtempSync(join(tmpdir(), "watch-hook-"));
  const transcript = join(root, "t.jsonl");
  writeFileSync(transcript, "");
  return { transcript, dir: root };
}

/** A server whose decision model speaks for the heads-up and is silent otherwise. */
function client(over: Partial<WatchClient> = {}): WatchClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    reflectMaybe: vi.fn(async (question: string) => {
      asked.push(question);
      return question === HEADSUP_Q
        ? { text: "Before you change units.py: K is 1024.", memoryIds: ["obs-1"], supported: true }
        : { text: "", memoryIds: [], supported: true };
    }),
    getMemory: vi.fn(async (id: string) =>
      id === "obs-1"
        ? { source_memory_ids: ["f-1"] }
        : { document_id: "conversation:s1", mentioned_at: "2026-10-01T10:00:00Z" }
    ),
    documentText: vi.fn(async () =>
      JSON.stringify({ role: "user", content: "Memory K is 1024, never 1000, for the vendor API." })
    ),
    ...over,
  };
}

describe("watchOnce", () => {
  it("gives the heads-up for a new request, with its source and a verbatim quote", async () => {
    const s = session();
    appendFileSync(s.transcript, prompt("Fix parse_quantity so pods get the memory they ask for."));
    const c = client();
    const note = await watchOnce({
      transcriptPath: s.transcript,
      cwd: s.dir,
      dir: s.dir,
      client: c,
      diff: () => "",
    });
    expect(note).toBe(
      `${NOTE_LEAD} Before you change units.py: K is 1024. Source: a past session (2026-10-01) — ` +
        `"Memory K is 1024, never 1000, for the vendor API."`
    );
    expect(c.asked).toEqual([HEADSUP_Q]);
  });

  it("reads on from where it stopped: the next run judges only what is new", async () => {
    const s = session();
    const c = client();
    appendFileSync(s.transcript, prompt("Fix parse_quantity."));
    await watchOnce({
      transcriptPath: s.transcript,
      cwd: s.dir,
      dir: s.dir,
      client: c,
      diff: () => "",
    });
    appendFileSync(s.transcript, edit("e1"));
    const note = await watchOnce({
      transcriptPath: s.transcript,
      cwd: s.dir,
      dir: s.dir,
      client: c,
      diff: () => "+K = 1024",
    });
    expect(note).toBeNull();
    expect(c.asked).toEqual([HEADSUP_Q, CONFLICT_Q]);
    // Nothing new since: no call at all.
    await watchOnce({
      transcriptPath: s.transcript,
      cwd: s.dir,
      dir: s.dir,
      client: c,
      diff: () => "+K = 1024",
    });
    expect(c.asked).toHaveLength(2);
  });

  it("an overlapping run leaves at once while another holds the session", async () => {
    const s = session();
    appendFileSync(s.transcript, prompt("Fix parse_quantity."));
    let release!: () => void;
    const slow = client({
      reflectMaybe: vi.fn(
        () =>
          new Promise(
            (resolve) => (release = () => resolve({ text: "", memoryIds: [], supported: true }))
          )
      ),
    });
    const holder = watchOnce({
      transcriptPath: s.transcript,
      cwd: s.dir,
      dir: s.dir,
      client: slow,
      diff: () => "",
    });
    await vi.waitFor(() => expect(slow.reflectMaybe).toHaveBeenCalled());
    const other = client();
    expect(
      await watchOnce({
        transcriptPath: s.transcript,
        cwd: s.dir,
        dir: s.dir,
        client: other,
        diff: () => "",
      })
    ).toBeNull();
    expect(other.reflectMaybe).not.toHaveBeenCalled();
    release();
    await holder;
  });

  it("goes quiet for the session on a server too old to abstain", async () => {
    const s = session();
    const old = client({
      reflectMaybe: vi.fn(async () => ({ text: "Some answer.", memoryIds: [], supported: false })),
    });
    appendFileSync(s.transcript, prompt("Fix parse_quantity."));
    expect(
      await watchOnce({
        transcriptPath: s.transcript,
        cwd: s.dir,
        dir: s.dir,
        client: old,
        diff: () => "",
      })
    ).toBeNull();
    appendFileSync(s.transcript, edit("e1"));
    expect(
      await watchOnce({
        transcriptPath: s.transcript,
        cwd: s.dir,
        dir: s.dir,
        client: old,
        diff: () => "+x",
      })
    ).toBeNull();
    expect(old.reflectMaybe).toHaveBeenCalledTimes(1);
  });

  it("a half-written last line waits for the next run", async () => {
    const s = session();
    const c = client();
    const full = prompt("Fix parse_quantity.");
    appendFileSync(s.transcript, full.slice(0, 20));
    expect(
      await watchOnce({
        transcriptPath: s.transcript,
        cwd: s.dir,
        dir: s.dir,
        client: c,
        diff: () => "",
      })
    ).toBeNull();
    appendFileSync(s.transcript, full.slice(20));
    expect(
      await watchOnce({
        transcriptPath: s.transcript,
        cwd: s.dir,
        dir: s.dir,
        client: c,
        diff: () => "",
      })
    ).toContain("K is 1024");
  });
});
