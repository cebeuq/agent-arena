import path from "node:path";
import type { RunAgent, RunState } from "../../src/types.js";

export function makeRunAgent(root: string, input: {
  id: string;
  name?: string;
  codename?: string;
  teamId: string;
  teamName?: string;
  captainAgentId?: string;
  isCaptain?: boolean;
  paneId?: string;
}): RunAgent {
  const workspace = path.join(root, "workspaces", input.id);
  return {
    id: input.id,
    name: input.name ?? input.id,
    codename: input.codename ?? input.id,
    teamId: input.teamId,
    teamName: input.teamName ?? `Team ${input.teamId}`,
    captainAgentId: input.captainAgentId ?? input.id,
    isCaptain: input.isCaptain ?? true,
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
    paneId: input.paneId ?? `%${input.id}`
  };
}

export function makeRunState(root: string, overrides: Partial<RunState> = {}): RunState {
  const runDir = path.join(root, "runs", "run-1");
  const agents = overrides.agents ?? [
    makeRunAgent(root, { id: "red-1", codename: "Nova", teamId: "red", teamName: "Team Red" }),
    makeRunAgent(root, { id: "blue-1", codename: "Kai", teamId: "blue", teamName: "Team Blue" })
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
    goal: "Win the fixture.",
    successCriteria: [],
    resources: [],
    judging: {
      mode: "manual"
    },
    teams: [
      {
        id: "red",
        name: "Team Red",
        captainAgentId: "red-1",
        agentIds: agents.filter((agent) => agent.teamId === "red").map((agent) => agent.id),
        resources: []
      },
      {
        id: "blue",
        name: "Team Blue",
        captainAgentId: "blue-1",
        agentIds: agents.filter((agent) => agent.teamId === "blue").map((agent) => agent.id),
        resources: []
      }
    ],
    peek: {
      refreshIntervalSeconds: 30,
      include: ["**/*"],
      exclude: []
    },
    tmux: {
      sessionName: "arena-fixture",
      attach: false
    },
    agents,
    claims: [],
    ...overrides
  };
}
