import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { OverseerApp } from "../src/tui/overseer/overseer-app.js";
import type { OverseerActions } from "../src/tui/overseer/actions.js";
import type { RunSnapshot, RunWatcher } from "../src/tui/overseer/run-watcher.js";
import { makeRunState } from "./helpers/state.js";

function makeSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    state: makeRunState("/tmp/overseer-fixture"),
    messages: [],
    reads: {},
    proposals: [],
    progress: [
      {
        agentId: "red-1",
        name: "Nova (red-1)",
        changedFiles: ["src/a.ts", "src/b.ts"],
        diffStat: " src/a.ts | 10 +++++-----",
        claimCount: 0
      },
      {
        agentId: "blue-1",
        name: "Kai (blue-1)",
        changedFiles: [],
        diffStat: "",
        claimCount: 0
      }
    ],
    daemonAlive: true,
    tmuxAlive: true,
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function fakeWatcher(snapshot: RunSnapshot): RunWatcher {
  const listeners = new Set<(snapshot: RunSnapshot) => void>();
  return {
    current: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    refreshNow: async () => {},
    stop: () => {}
  };
}

function fakeActions(): OverseerActions {
  return {
    sendUserChat: vi.fn(async (options) => ({
      id: "m-x",
      createdAt: new Date().toISOString(),
      scope: options.scope,
      fromAgentId: "user",
      fromCodename: "Director",
      fromTeamId: "user",
      message: options.message
    })),
    markThreadRead: vi.fn(async () => {}),
    acceptClaim: vi.fn(async (agentId: string) => ({
      agentId,
      claimedAt: "now",
      status: "accepted" as const,
      stdout: "",
      stderr: ""
    })),
    rejectClaim: vi.fn(async (agentId: string) => ({
      agentId,
      claimedAt: "now",
      status: "rejected" as const,
      stdout: "",
      stderr: ""
    })),
    askForMore: vi.fn(async () => ({
      id: "m-q",
      createdAt: new Date().toISOString(),
      scope: "dm" as const,
      fromAgentId: "user",
      fromCodename: "Director",
      fromTeamId: "user",
      message: "q"
    })),
    applyProposal: vi.fn(async () => {
      throw new Error("not used");
    }),
    sendPressure: vi.fn(async () => 2),
    restartDaemon: vi.fn(async () => 1234)
  };
}

async function waitFor(assertion: () => void, timeoutMs = 2500): Promise<void> {
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

async function press(stdin: { write: (data: string) => void }, data: string): Promise<void> {
  stdin.write(data);
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("overseer app", () => {
  it("renders the dashboard with team groups, agent rows, and health badges", async () => {
    const snapshot = makeSnapshot();
    const { lastFrame } = render(
      <OverseerApp watcher={fakeWatcher(snapshot)} actions={fakeActions()} initialSnapshot={snapshot} />
    );

    await waitFor(() => {
      const frame = lastFrame()!;
      expect(frame).toContain("Overseer — run run-1");
      expect(frame).toContain("RUNNING");
      expect(frame).toContain("Team Red");
      expect(frame).toContain("Nova (red-1)");
      expect(frame).toContain("files:2");
      expect(frame).toContain("daemon: ok");
    });
  });

  it("shows a claim banner and judges a claim with a danger confirm", async () => {
    const snapshot = makeSnapshot({
      state: makeRunState("/tmp/overseer-fixture", {
        claims: [
          { agentId: "red-1", teamId: "red", claimedAt: "2026-06-09T12:00:00.000Z", status: "pending", stdout: "", stderr: "" }
        ]
      })
    });
    const actions = fakeActions();
    const { stdin, lastFrame } = render(
      <OverseerApp watcher={fakeWatcher(snapshot)} actions={actions} initialSnapshot={snapshot} />
    );

    await waitFor(() => expect(lastFrame()).toContain("claims FINISH"));
    await press(stdin, "4");
    await waitFor(() => expect(lastFrame()).toContain("Pending claims (1)"));
    await press(stdin, "a");
    await waitFor(() => expect(lastFrame()).toContain("Accept claim and END the run?"));
    await press(stdin, "y");
    await waitFor(() => expect(actions.acceptClaim).toHaveBeenCalledWith("red-1"));
  });

  it("rejecting asks for a note and keeps the run going", async () => {
    const snapshot = makeSnapshot({
      state: makeRunState("/tmp/overseer-fixture", {
        claims: [
          { agentId: "red-1", teamId: "red", claimedAt: "2026-06-09T12:00:00.000Z", status: "pending", stdout: "", stderr: "" }
        ]
      })
    });
    const actions = fakeActions();
    const { stdin, lastFrame } = render(
      <OverseerApp watcher={fakeWatcher(snapshot)} actions={actions} initialSnapshot={snapshot} />
    );

    await press(stdin, "4");
    await waitFor(() => expect(lastFrame()).toContain("Claim by Nova"));
    await press(stdin, "x");
    await waitFor(() => expect(lastFrame()).toContain("Reject red-1's claim"));
    stdin.write("not done yet");
    await waitFor(() => expect(lastFrame()).toContain("not done yet"));
    await press(stdin, "\r");
    await waitFor(() => expect(actions.rejectClaim).toHaveBeenCalledWith("red-1", "not done yet"));
  });

  it("sends a Director message from the chat view", async () => {
    const snapshot = makeSnapshot();
    const actions = fakeActions();
    const { stdin, lastFrame } = render(
      <OverseerApp watcher={fakeWatcher(snapshot)} actions={actions} initialSnapshot={snapshot} />
    );

    await press(stdin, "2");
    await waitFor(() => {
      expect(lastFrame()).toContain("Threads");
      expect(lastFrame()).toContain("Public");
      expect(lastFrame()).toContain("DM Nova (red-1)");
    });
    await press(stdin, "\r"); // Enter on the selected thread focuses the input
    await waitFor(() => expect(lastFrame()).toContain("Message as Director"));
    stdin.write("status update please");
    await waitFor(() => expect(lastFrame()).toContain("status update please"));
    await press(stdin, "\r");
    await waitFor(() =>
      expect(actions.sendUserChat).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "public", message: "status update please" })
      )
    );
  });

  it("shows the winner banner and disables actions when the run is finished", async () => {
    const snapshot = makeSnapshot({
      state: makeRunState("/tmp/overseer-fixture", {
        status: "finished",
        finishedAt: new Date().toISOString(),
        winner: { agentId: "red-1", teamId: "red", claimedAt: "x", verifiedAt: "y", elapsedMs: 60000 }
      })
    });
    const actions = fakeActions();
    const { stdin, lastFrame } = render(
      <OverseerApp watcher={fakeWatcher(snapshot)} actions={actions} initialSnapshot={snapshot} />
    );

    await waitFor(() => {
      expect(lastFrame()).toContain("WINNER: red-1");
      expect(lastFrame()).toContain("FINISHED");
    });
    await press(stdin, "p"); // pressure must be ignored in read-only mode
    expect(actions.sendPressure).not.toHaveBeenCalled();
    await press(stdin, "2");
    await waitFor(() => expect(lastFrame()).toContain("chat is read-only history"));
  });
});
