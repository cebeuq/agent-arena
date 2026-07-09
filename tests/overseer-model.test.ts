import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/chat.js";
import type { RunSnapshot } from "../src/tui/overseer/run-watcher.js";
import { formatElapsed } from "../src/format.js";
import {
  agentRunState,
  askedForMoreAt,
  buildThreads,
  pendingClaims,
  summarizePatch,
  threadMessages,
  unreadCountForAgent,
  unreadMessageIdsForUser
} from "../src/tui/overseer/model.js";
import { makeRunState } from "./helpers/state.js";

function message(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    createdAt: "2026-06-09T00:00:00.000Z",
    scope: "public",
    fromAgentId: "red-1",
    fromCodename: "Nova",
    fromTeamId: "red",
    message: "hello",
    ...partial
  };
}

function makeSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    state: makeRunState("/tmp/fixture"),
    messages: [],
    reads: {},
    proposals: [],
    progress: [],
    daemonAlive: true,
    tmuxAlive: true,
    updatedAt: "2026-06-09T00:00:00.000Z",
    ...overrides
  };
}

describe("agent run state", () => {
  it("derives working, claimed, winner, and stopped states", () => {
    const base = makeSnapshot();
    expect(agentRunState(base, "red-1")).toBe("working");

    const claimed = makeSnapshot({
      state: makeRunState("/tmp/fixture", {
        claims: [
          {
            agentId: "red-1",
            claimedAt: "2026-06-09T00:00:00.000Z",
            status: "pending",
            stdout: "",
            stderr: ""
          }
        ]
      })
    });
    expect(agentRunState(claimed, "red-1")).toBe("claimed");
    expect(pendingClaims(claimed)).toHaveLength(1);

    const finished = makeSnapshot({
      state: makeRunState("/tmp/fixture", {
        status: "finished",
        winner: {
          agentId: "red-1",
          claimedAt: "x",
          verifiedAt: "y",
          elapsedMs: 1000
        }
      })
    });
    expect(agentRunState(finished, "red-1")).toBe("winner");
    expect(agentRunState(finished, "blue-1")).toBe("stopped");
  });
});

describe("chat threads", () => {
  it("builds public, team, and DM threads with user unread counts", () => {
    const snapshot = makeSnapshot({
      messages: [
        message({ id: "m1", scope: "public", message: "hi all" }),
        message({ id: "m2", scope: "team", teamId: "red", message: "team only" }),
        message({ id: "m3", scope: "dm", toAgentId: "user", message: "for the director" }),
        message({ id: "m4", scope: "dm", fromAgentId: "user", fromCodename: "Director", fromTeamId: "user", toAgentId: "red-1", message: "from the director" })
      ],
      reads: { user: ["m1"] }
    });

    const threads = buildThreads(snapshot);
    const labels = threads.map((thread) => thread.id);
    expect(labels).toEqual(["public", "team:red", "team:blue", "dm:red-1", "dm:blue-1"]);

    const publicThread = threads[0];
    expect(publicThread.unread).toBe(0); // m1 read

    const redTeam = threads[1];
    expect(redTeam.unread).toBe(1); // m2

    const redDm = threads[3];
    expect(threadMessages(snapshot, redDm).map((m) => m.id)).toEqual(["m3", "m4"]);
    expect(redDm.unread).toBe(1); // m3 unread; m4 is the user's own
    expect(unreadMessageIdsForUser(snapshot, redDm)).toEqual(["m3"]);
  });

  it("counts unread per agent for the dashboard", () => {
    const snapshot = makeSnapshot({
      messages: [
        message({ id: "m1", scope: "public", fromAgentId: "blue-1", fromCodename: "Kai", fromTeamId: "blue" }),
        message({ id: "m2", scope: "team", teamId: "blue", fromAgentId: "user", fromCodename: "Director", fromTeamId: "user" })
      ],
      reads: {}
    });
    expect(unreadCountForAgent(snapshot, "red-1")).toBe(1); // public only
    expect(unreadCountForAgent(snapshot, "blue-1")).toBe(1); // own public message excluded, team message counts
  });
});

describe("patch summary", () => {
  it("counts files and line deltas from a unified diff", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@",
      " unchanged",
      "+added line",
      "+another",
      "-removed",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -0,0 +1 @@",
      "+new"
    ].join("\n");

    const summary = summarizePatch(patch);
    expect(summary.files).toEqual([
      { path: "src/a.ts", additions: 2, deletions: 1 },
      { path: "src/b.ts", additions: 1, deletions: 0 }
    ]);
    expect(summary.additions).toBe(3);
    expect(summary.deletions).toBe(1);
  });
});

describe("judge annotations", () => {
  it("finds the latest director question newer than the claim", () => {
    const snapshot = makeSnapshot({
      state: makeRunState("/tmp/fixture", {
        claims: [
          { agentId: "red-1", claimedAt: "2026-06-09T01:00:00.000Z", status: "pending", stdout: "", stderr: "" }
        ]
      }),
      messages: [
        message({
          id: "early",
          scope: "dm",
          fromAgentId: "user",
          fromCodename: "Director",
          fromTeamId: "user",
          toAgentId: "red-1",
          createdAt: "2026-06-09T00:30:00.000Z"
        }),
        message({
          id: "after",
          scope: "dm",
          fromAgentId: "user",
          fromCodename: "Director",
          fromTeamId: "user",
          toAgentId: "red-1",
          createdAt: "2026-06-09T01:10:00.000Z"
        })
      ]
    });

    expect(askedForMoreAt(snapshot, snapshot.state.claims[0])).toBe("2026-06-09T01:10:00.000Z");
  });
});

describe("formatElapsed", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(95_000)).toBe("1m 35s");
    expect(formatElapsed(3_900_000)).toBe("1h 5m");
  });
});
