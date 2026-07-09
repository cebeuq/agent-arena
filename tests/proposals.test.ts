import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { applyProposal, createProposal, proposalHistory } from "../src/proposals.js";
import type { RunAgent, RunState } from "../src/types.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function run(command: string[], cwd: string): void {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`${command.join(" ")} failed:\n${result.stderr}`);
  }
}

async function initRepo(workspace: string): Promise<void> {
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  run(["git", "init"], workspace);
  run(["git", "config", "user.email", "arena@example.test"], workspace);
  run(["git", "config", "user.name", "Arena Test"], workspace);
  await fs.writeFile(path.join(workspace, "src", "value.txt"), "one\n", "utf8");
  run(["git", "add", "src/value.txt"], workspace);
  run(["git", "commit", "-m", "baseline"], workspace);
}

function makeAgent(root: string, input: {
  id: string;
  codename: string;
  teamId: string;
  teamName: string;
  captainAgentId: string;
  isCaptain: boolean;
}): RunAgent {
  const workspace = path.join(root, "workspaces", input.id);
  return {
    id: input.id,
    name: input.id,
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
    rivalDirs: {}
  };
}

async function makeState(): Promise<RunState> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-arena-proposal-"));
  tempDirs.push(root);
  const runDir = path.join(root, "runs", "run-1");
  await fs.mkdir(runDir, { recursive: true });

  const agents = [
    makeAgent(root, {
      id: "red-captain",
      codename: "Nova",
      teamId: "red",
      teamName: "Team Red",
      captainAgentId: "red-captain",
      isCaptain: true
    }),
    makeAgent(root, {
      id: "red-worker",
      codename: "Ada",
      teamId: "red",
      teamName: "Team Red",
      captainAgentId: "red-captain",
      isCaptain: false
    }),
    makeAgent(root, {
      id: "blue-captain",
      codename: "Kai",
      teamId: "blue",
      teamName: "Team Blue",
      captainAgentId: "blue-captain",
      isCaptain: true
    })
  ];

  await Promise.all(agents.map((agent) => initRepo(agent.workspace)));

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

describe("patch proposals", () => {
  it("lets a non-captain propose a diff and the team captain apply it", async () => {
    const state = await makeState();
    const worker = state.agents.find((agent) => agent.id === "red-worker")!;
    const captain = state.agents.find((agent) => agent.id === "red-captain")!;
    await fs.writeFile(path.join(worker.workspace, "src", "value.txt"), "two\n", "utf8");
    await fs.mkdir(path.join(worker.workspace, ".arena", "rivals", "blue-captain"), { recursive: true });
    await fs.writeFile(path.join(worker.workspace, ".arena", "scoreboard.md"), "generated scoreboard\n", "utf8");
    await fs.writeFile(path.join(worker.workspace, ".arena", "rivals", "blue-captain", "note.txt"), "rival mirror\n", "utf8");

    const proposal = await createProposal(state, {
      agentId: worker.id,
      title: "Change value",
      summary: "Updates the fixture value."
    });

    expect(proposal.status).toBe("pending");
    const patch = await fs.readFile(proposal.patchPath, "utf8");
    expect(patch).toContain("+two");
    expect(patch).not.toContain(".arena/");
    await expect(fs.readFile(path.join(captain.workspace, ".arena", "proposals", "inbox.md"), "utf8")).resolves.toContain(
      "pending for captain"
    );

    const applied = await applyProposal(state, {
      agentId: captain.id,
      proposalId: proposal.id
    });

    expect(applied.status).toBe("applied");
    await expect(fs.readFile(path.join(captain.workspace, "src", "value.txt"), "utf8")).resolves.toBe("two\n");
    await expect(proposalHistory(state, "red")).resolves.toContain("Change value [applied]");
  });

  it("blocks captains from proposing and non-captains from applying", async () => {
    const state = await makeState();
    const worker = state.agents.find((agent) => agent.id === "red-worker")!;
    await fs.writeFile(path.join(worker.workspace, "src", "value.txt"), "two\n", "utf8");
    const proposal = await createProposal(state, {
      agentId: worker.id,
      title: "Change value",
      summary: "Updates the fixture value."
    });

    await expect(
      createProposal(state, {
        agentId: "red-captain",
        title: "Captain patch",
        summary: "Should be rejected."
      })
    ).rejects.toThrow(/non-captain teammates/);
    await expect(
      applyProposal(state, {
        agentId: worker.id,
        proposalId: proposal.id
      })
    ).rejects.toThrow(/Only the team captain/);
  });
});
