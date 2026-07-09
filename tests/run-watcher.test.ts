import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunWatcher, type RunSnapshot, type RunWatcher } from "../src/tui/overseer/run-watcher.js";
import { makeRunState } from "./helpers/state.js";
import type { RunState } from "../src/types.js";

let tempDirs: string[] = [];
let watchers: RunWatcher[] = [];

afterEach(async () => {
  for (const watcher of watchers) {
    watcher.stop();
  }
  watchers = [];
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function writeState(state: RunState): Promise<void> {
  await fs.mkdir(path.dirname(state.statePath), { recursive: true });
  await fs.writeFile(state.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function makeRunDir(): Promise<RunState> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arena-watcher-"));
  tempDirs.push(root);
  const state = makeRunState(root);
  await writeState(state);
  return state;
}

function watch(state: RunState, overrides: Partial<Parameters<typeof createRunWatcher>[0]> = {}): RunWatcher {
  const watcher = createRunWatcher({
    statePath: state.statePath,
    stateIntervalMs: 25,
    progressIntervalMs: 60,
    collectProgress: async () => [],
    probeDaemon: () => true,
    probeTmux: () => true,
    ...overrides
  });
  watchers.push(watcher);
  return watcher;
}

async function waitFor(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}

describe("run watcher", () => {
  it("refreshNow immediately after creation always yields a snapshot", async () => {
    // Regression: the constructor's kicked-off refresh used to make an
    // immediate refreshNow() return without doing anything, leaving current()
    // undefined and crashing the overseer right after launch.
    const state = await makeRunDir();
    const watcher = watch(state, {
      collectProgress: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80)); // slow first pass
        return [];
      }
    });
    await watcher.refreshNow();
    expect(watcher.current()).toBeDefined();
    expect(watcher.current()?.state.runId).toBe("run-1");
  });

  it("emits an initial snapshot and reacts to state changes", async () => {
    const state = await makeRunDir();
    const snapshots: RunSnapshot[] = [];
    const watcher = watch(state);
    watcher.subscribe((snapshot) => snapshots.push(snapshot));

    await waitFor(() => expect(snapshots.length).toBeGreaterThan(0));
    expect(snapshots[0].state.runId).toBe("run-1");
    expect(snapshots[0].state.status).toBe("running");

    await writeState({ ...state, status: "finished", finishedAt: new Date().toISOString() });
    await waitFor(() => {
      expect(snapshots[snapshots.length - 1].state.status).toBe("finished");
    });
  });

  it("picks up appended chat messages and proposals", async () => {
    const state = await makeRunDir();
    const watcher = watch(state);
    await waitFor(() => expect(watcher.current()).toBeDefined());

    const chatDir = path.join(state.runDir, "chat");
    await fs.mkdir(chatDir, { recursive: true });
    await fs.appendFile(
      path.join(chatDir, "messages.jsonl"),
      `${JSON.stringify({
        id: "m1",
        createdAt: new Date().toISOString(),
        scope: "public",
        fromAgentId: "red-1",
        fromCodename: "Nova",
        fromTeamId: "red",
        message: "live message"
      })}\n`,
      "utf8"
    );

    await waitFor(() => {
      expect(watcher.current()?.messages.map((message) => message.id)).toEqual(["m1"]);
    });
  });

  it("keeps the last good snapshot when the state file is temporarily corrupt", async () => {
    const state = await makeRunDir();
    const watcher = watch(state);
    await waitFor(() => expect(watcher.current()).toBeDefined());

    await fs.writeFile(state.statePath, "{ not json", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(watcher.current()?.state.runId).toBe("run-1");

    await writeState({ ...state, goal: "healed" });
    await waitFor(() => expect(watcher.current()?.state.goal).toBe("healed"));
  });

  it("refreshes progress on the slow cadence and on demand", async () => {
    const state = await makeRunDir();
    let calls = 0;
    const watcher = watch(state, {
      collectProgress: async () => {
        calls += 1;
        return [];
      },
      progressIntervalMs: 10_000
    });
    await waitFor(() => expect(watcher.current()).toBeDefined());
    const before = calls;
    expect(before).toBeGreaterThan(0);

    // Fast state polls must not re-run git progress within the slow window.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(calls).toBe(before);

    await watcher.refreshNow();
    expect(calls).toBe(before + 1);
  });

  it("surfaces daemon and tmux probe results", async () => {
    const state = await makeRunDir();
    const watcher = watch(state, {
      probeDaemon: () => false,
      probeTmux: () => false
    });
    await waitFor(() => {
      expect(watcher.current()?.daemonAlive).toBe(false);
      expect(watcher.current()?.tmuxAlive).toBe(false);
    });
  });
});
