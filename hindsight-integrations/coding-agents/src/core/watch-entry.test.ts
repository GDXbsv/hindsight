import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CONFIG_PATH is read when config.ts loads, so each test points HINDSIGHT_CONFIG at its own file
// and imports a fresh copy.
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hs-watch-entry-"));
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HINDSIGHT_CONFIG;
  rmSync(root, { recursive: true, force: true });
});

async function watchConfigWith(config: object) {
  process.env.HINDSIGHT_CONFIG = join(root, "coding-agent.json");
  writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify(config));
  const { watchConfig } = await import("./watch-entry");
  return watchConfig({ harness: "claude-code" } as never, root);
}

describe("watchConfig: the per-repo override decides whether this session watches", () => {
  it("watches by default on Claude Code", async () => {
    expect((await watchConfigWith({ bankId: "b1" }))?.bankId).toBe("b1");
  });

  it("a repo set to reflect does not watch, though the global default does", async () => {
    expect(
      await watchConfigWith({ bankId: "b1", banks: { b1: { autoInject: "reflect" } } })
    ).toBeNull();
  });

  it("a repo set to watch watches, though the global setting is reflect", async () => {
    const got = await watchConfigWith({
      bankId: "b1",
      autoInject: "reflect",
      banks: { b1: { autoInject: "watch" } },
    });
    expect(got?.cfg.autoInject).toBe("watch");
  });

  it("a disabled repo does not watch", async () => {
    expect(await watchConfigWith({ bankId: "b1", banks: { b1: { disabled: true } } })).toBeNull();
  });
});

describe("every watching harness is wired to its session", () => {
  it("has a watch entry, a PostToolUse watch hook and a Stop hook that ends the session's turn", async () => {
    const { WATCH_HARNESSES } = await import("./config");
    const { WATCH_ENTRIES } = await import("./watch-entry");
    const { HOOK_HARNESSES } = await import("../harness/hook-lifecycle");
    for (const harness of WATCH_HARNESSES) {
      const spec = HOOK_HARNESSES[harness as keyof typeof HOOK_HARNESSES];
      expect(spec, harness).toBeDefined();
      expect(WATCH_ENTRIES[harness], harness).toBeTruthy();
      expect(
        spec.additionalHooks?.map((h) => h.entry),
        harness
      ).toContain(WATCH_ENTRIES[harness]);
      // Without it the Stop hook writes the transcript itself next to the session's own save.
      expect(spec.retain?.watch?.eventsOf, harness).toBeTypeOf("function");
    }
  });
});
