import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chatHistory,
  markMessagesRead,
  readChatReadState,
  readInbox,
  sendChatMessage,
  sendPendingChatReminders,
  USER_SENDER_ID
} from "../src/chat.js";
import type { RunAgent, RunState } from "../src/types.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeAgent(root: string, input: {
  id: string;
  name: string;
  codename: string;
  teamId: string;
  teamName: string;
  captainAgentId: string;
  isCaptain: boolean;
  paneId: string;
}): RunAgent {
  const workspace = path.join(root, "workspaces", input.id);
  return {
    id: input.id,
    name: input.name,
    codename: input.codename,
    teamId: input.teamId,
    teamName: input.teamName,
    captainAgentId: input.captainAgentId,
    isCaptain: input.isCaptain,
    command: `fake-${input.id}`,
    configuredGoalMode: "prompt",
    launchMode: "prompt",
    resources: [],
    teamResources: [],
    workspace,
    branch: input.id,
    goalFile: path.join(workspace, ".arena", "goal.md"),
    briefFile: path.join(workspace, ".arena", "brief.md"),
    claimScript: path.join(workspace, ".arena", "claim.sh"),
    claimCommand: `claim-${input.id}`,
    chatScript: path.join(workspace, ".arena", "chat.sh"),
    chatCommand: `chat-${input.id}`,
    chatInboxCommand: `chat-${input.id} inbox`,
    chatHistoryCommand: `chat-${input.id} history`,
    proposePatchScript: path.join(workspace, ".arena", "propose-patch.sh"),
    proposePatchCommand: `proposal-${input.id}`,
    applyProposalScript: path.join(workspace, ".arena", "apply-proposal.sh"),
    applyProposalCommand: `apply-${input.id}`,
    rivalsDir: path.join(workspace, ".arena", "rivals"),
    rivalDirs: {},
    paneId: input.paneId
  };
}

async function makeState(): Promise<RunState> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-arena-chat-"));
  tempDirs.push(root);
  const runDir = path.join(root, "runs", "run-1");
  await fs.mkdir(runDir, { recursive: true });

  const agents = [
    makeAgent(root, {
      id: "red-captain",
      name: "Codex Red",
      codename: "Nova",
      teamId: "red",
      teamName: "Team Red",
      captainAgentId: "red-captain",
      isCaptain: true,
      paneId: "%red-captain"
    }),
    makeAgent(root, {
      id: "red-worker",
      name: "Claude Red",
      codename: "Ada",
      teamId: "red",
      teamName: "Team Red",
      captainAgentId: "red-captain",
      isCaptain: false,
      paneId: "%red-worker"
    }),
    makeAgent(root, {
      id: "blue-captain",
      name: "Codex Blue",
      codename: "Kai",
      teamId: "blue",
      teamName: "Team Blue",
      captainAgentId: "blue-captain",
      isCaptain: true,
      paneId: "%blue-captain"
    })
  ];

  return {
    runId: "run-1",
    status: "running",
    startedAt: new Date().toISOString(),
    baseRepo: root,
    baseRef: "HEAD",
    arenaRoot: root,
    runDir,
    statePath: path.join(runDir, "state.json"),
    goal: "Win.",
    successCriteria: [],
    resources: [],
    judging: {
      mode: "manual"
    },
    teams: [
      {
        id: "red",
        name: "Team Red",
        captainAgentId: "red-captain",
        agentIds: ["red-captain", "red-worker"],
        resources: []
      },
      {
        id: "blue",
        name: "Team Blue",
        captainAgentId: "blue-captain",
        agentIds: ["blue-captain"],
        resources: []
      }
    ],
    peek: {
      refreshIntervalSeconds: 30,
      include: ["**/*"],
      exclude: []
    },
    tmux: {
      sessionName: "arena",
      attach: false
    },
    agents,
    claims: []
  };
}

async function chatFile(agent: RunAgent, file: string): Promise<string> {
  return fs.readFile(path.join(path.dirname(agent.goalFile), "chat", file), "utf8");
}

describe("agent chat", () => {
  it("renders team, public, and DM scopes to the right workspaces", async () => {
    const state = await makeState();
    const notices: Array<{ pane?: string; message: string }> = [];

    await sendChatMessage(state, {
      fromAgentId: "red-worker",
      scope: "team",
      message: "I am exploring parser changes.",
      sender: (pane, message) => notices.push({ pane, message })
    });
    expect(notices.map((notice) => notice.pane)).toEqual(["%red-captain"]);
    expect(notices[0].message).toContain("pending team message from Ada");

    await sendChatMessage(state, {
      fromAgentId: "blue-captain",
      scope: "public",
      message: "Blue has a runnable baseline.",
      sender: (pane, message) => notices.push({ pane, message })
    });

    await sendChatMessage(state, {
      fromAgentId: "red-captain",
      scope: "dm",
      toAgentId: "blue-captain",
      message: "Can you share your benchmark command?",
      sender: (pane, message) => notices.push({ pane, message })
    });

    const redCaptain = state.agents[0];
    const redWorker = state.agents[1];
    const blueCaptain = state.agents[2];

    await expect(chatFile(redCaptain, "team.md")).resolves.toContain("I am exploring parser changes.");
    await expect(chatFile(blueCaptain, "team.md")).resolves.not.toContain("I am exploring parser changes.");
    await expect(chatFile(redWorker, "public.md")).resolves.toContain("Blue has a runnable baseline.");
    await expect(chatFile(blueCaptain, "dms.md")).resolves.toContain("Can you share your benchmark command?");
    await expect(chatFile(redWorker, "dms.md")).resolves.not.toContain("Can you share your benchmark command?");

    const visibleToRed = await chatHistory(state, { agentId: "red-worker" });
    expect(visibleToRed).toContain("Blue has a runnable baseline.");
    expect(visibleToRed).not.toContain("Can you share your benchmark command?");
  });

  it("marks inbox messages read only when the recipient checks inbox", async () => {
    const state = await makeState();

    await sendChatMessage(state, {
      fromAgentId: "red-worker",
      scope: "team",
      message: "Please review my patch proposal.",
      sender: () => {}
    });

    await expect(chatFile(state.agents[0], "inbox.md")).resolves.toContain("Unread: 1");
    const unread = await readInbox(state, "red-captain");
    expect(unread).toHaveLength(1);
    await expect(chatFile(state.agents[0], "inbox.md")).resolves.toContain("Unread: 0");
    await expect(readInbox(state, "red-captain")).resolves.toEqual([]);
  });

  it("blocks self-DMs and sends one delayed reminder per unread batch", async () => {
    const state = await makeState();
    const sentAt = new Date("2026-06-08T00:00:00.000Z");
    const notices: string[] = [];

    await expect(
      sendChatMessage(state, {
        fromAgentId: "red-captain",
        scope: "dm",
        toAgentId: "red-captain",
        message: "Self note"
      })
    ).rejects.toThrow(/themselves/);

    await sendChatMessage(state, {
      fromAgentId: "red-captain",
      scope: "dm",
      toAgentId: "blue-captain",
      message: "Need your benchmark command.",
      now: sentAt,
      sender: (_pane, message) => notices.push(message)
    });

    expect(await sendPendingChatReminders(state, new Date("2026-06-08T00:01:59.000Z"), (_pane, message) => notices.push(message))).toBe(0);
    expect(await sendPendingChatReminders(state, new Date("2026-06-08T00:02:01.000Z"), (_pane, message) => notices.push(message))).toBe(1);
    expect(await sendPendingChatReminders(state, new Date("2026-06-08T00:04:30.000Z"), (_pane, message) => notices.push(message))).toBe(0);
    expect(notices.filter((message) => message.includes("pending DM message from Nova"))).toHaveLength(2);
  });
});

describe("director (user) chat", () => {
  it("sends user team messages to that team only and nudges their panes", async () => {
    const state = await makeState();
    const notices: Array<{ pane?: string; message: string }> = [];

    const message = await sendChatMessage(state, {
      fromAgentId: USER_SENDER_ID,
      scope: "team",
      teamId: "red",
      message: "Focus on the parser first.",
      sender: (pane, text) => notices.push({ pane, message: text })
    });

    expect(message.fromCodename).toBe("Director");
    expect(notices.map((notice) => notice.pane).sort()).toEqual(["%red-captain", "%red-worker"]);
    expect(notices[0].message).toContain("from Director");

    await expect(chatFile(state.agents[0], "team.md")).resolves.toContain("Focus on the parser first.");
    await expect(chatFile(state.agents[2], "team.md")).resolves.not.toContain("Focus on the parser first.");
  });

  it("requires a team id for user team messages", async () => {
    const state = await makeState();
    await expect(
      sendChatMessage(state, {
        fromAgentId: USER_SENDER_ID,
        scope: "team",
        message: "no team"
      })
    ).rejects.toThrow(/--team/);
    await expect(
      sendChatMessage(state, {
        fromAgentId: USER_SENDER_ID,
        scope: "team",
        teamId: "ghost",
        message: "bad team"
      })
    ).rejects.toThrow(/Unknown team/);
  });

  it("nudges every agent on a public user message", async () => {
    const state = await makeState();
    const panes: Array<string | undefined> = [];
    await sendChatMessage(state, {
      fromAgentId: USER_SENDER_ID,
      scope: "public",
      message: "Halfway point: claims welcome.",
      sender: (pane) => panes.push(pane)
    });
    expect(panes.sort()).toEqual(["%blue-captain", "%red-captain", "%red-worker"]);
  });

  it("lets agents DM the user and tracks user read state", async () => {
    const state = await makeState();

    const toUser = await sendChatMessage(state, {
      fromAgentId: "red-captain",
      scope: "dm",
      toAgentId: USER_SENDER_ID,
      message: "Judge question answered in workspace notes.",
      sender: () => {}
    });
    expect(toUser.toAgentId).toBe(USER_SENDER_ID);

    await markMessagesRead(state, USER_SENDER_ID, [toUser.id]);
    const reads = await readChatReadState(state);
    expect(reads[USER_SENDER_ID]).toEqual([toUser.id]);
  });

  it("delivers user DMs to the recipient agent's inbox", async () => {
    const state = await makeState();
    await sendChatMessage(state, {
      fromAgentId: USER_SENDER_ID,
      scope: "dm",
      toAgentId: "blue-captain",
      message: "Can you explain your approach?",
      sender: () => {}
    });

    const unread = await readInbox(state, "blue-captain");
    expect(unread).toHaveLength(1);
    expect(unread[0].fromCodename).toBe("Director");
    await expect(chatFile(state.agents[2], "dms.md")).resolves.toContain("Can you explain your approach?");
  });
});
