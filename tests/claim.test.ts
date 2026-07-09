import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { acceptManualClaim, claimRun, rejectManualClaim } from "../src/claim.js";
import { writeRunState } from "../src/run-state.js";
import type { RunState } from "../src/types.js";

let tempDirs: string[] = [];

async function makeWritable(target: string): Promise<void> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) {
      await fs.chmod(target, 0o755);
      for (const entry of await fs.readdir(target)) {
        await makeWritable(path.join(target, entry));
      }
    } else {
      await fs.chmod(target, 0o644);
    }
  } catch {
    // Best-effort cleanup helper.
  }
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await makeWritable(dir);
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function makeState(mode: "verifier" | "manual" = "verifier"): Promise<RunState> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-arena-claim-"));
  tempDirs.push(root);

  const runDir = path.join(root, "runs", "run-1");
  const statePath = path.join(runDir, "state.json");
  const workspaceA = path.join(root, "workspaces", "a");
  const workspaceB = path.join(root, "workspaces", "b");

  await fs.mkdir(path.join(workspaceA, ".arena", "rivals", "b"), { recursive: true });
  await fs.mkdir(path.join(workspaceB, ".arena", "rivals", "a"), { recursive: true });
  await fs.mkdir(runDir, { recursive: true });

  const state: RunState = {
    runId: "run-1",
    status: "running",
    startedAt: new Date(Date.now() - 1000).toISOString(),
    baseRepo: root,
    baseRef: "HEAD",
    arenaRoot: root,
    runDir,
    statePath,
    goal: "Create a pass file.",
    successCriteria: ["A pass file exists."],
    resources: [],
    verifyCommand: mode === "verifier" ? "test -f pass" : undefined,
    judging:
      mode === "verifier"
        ? {
            mode: "verifier",
            verifyCommand: "test -f pass"
          }
        : {
            mode: "manual"
          },
    peek: {
      refreshIntervalSeconds: 30,
      include: ["**/*"],
      exclude: [".arena/**", ".git/**"]
    },
    tmux: {
      sessionName: "missing-session",
      attach: false
    },
    agents: [
      {
        id: "a",
        name: "Agent A",
        command: "fake-a",
        configuredGoalMode: "prompt",
        launchMode: "prompt",
        resources: [],
        workspace: workspaceA,
        branch: "a",
        goalFile: path.join(workspaceA, ".arena", "goal.md"),
        briefFile: path.join(workspaceA, ".arena", "brief.md"),
        claimScript: path.join(workspaceA, ".arena", "claim.sh"),
        claimCommand: "claim-a",
        rivalsDir: path.join(workspaceA, ".arena", "rivals"),
        rivalDirs: {
          b: path.join(workspaceA, ".arena", "rivals", "b")
        }
      },
      {
        id: "b",
        name: "Agent B",
        command: "fake-b",
        configuredGoalMode: "prompt",
        launchMode: "prompt",
        resources: [],
        workspace: workspaceB,
        branch: "b",
        goalFile: path.join(workspaceB, ".arena", "goal.md"),
        briefFile: path.join(workspaceB, ".arena", "brief.md"),
        claimScript: path.join(workspaceB, ".arena", "claim.sh"),
        claimCommand: "claim-b",
        rivalsDir: path.join(workspaceB, ".arena", "rivals"),
        rivalDirs: {
          a: path.join(workspaceB, ".arena", "rivals", "a")
        }
      }
    ],
    claims: []
  };

  await writeRunState(state);
  return state;
}

async function makeTeamState(): Promise<RunState> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-arena-claim-team-"));
  tempDirs.push(root);

  const runDir = path.join(root, "runs", "run-1");
  const statePath = path.join(runDir, "state.json");
  const captainWorkspace = path.join(root, "workspaces", "red-captain");
  const workerWorkspace = path.join(root, "workspaces", "red-worker");
  const blueWorkspace = path.join(root, "workspaces", "blue-captain");

  await fs.mkdir(path.join(captainWorkspace, ".arena", "rivals", "blue-captain"), { recursive: true });
  await fs.mkdir(path.join(workerWorkspace, ".arena", "rivals", "blue-captain"), { recursive: true });
  await fs.mkdir(path.join(blueWorkspace, ".arena", "rivals", "red-captain"), { recursive: true });
  await fs.mkdir(runDir, { recursive: true });

  const state: RunState = {
    runId: "run-1",
    status: "running",
    startedAt: new Date(Date.now() - 1000).toISOString(),
    baseRepo: root,
    baseRef: "HEAD",
    arenaRoot: root,
    runDir,
    statePath,
    goal: "Create a pass file.",
    successCriteria: ["A pass file exists."],
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
      exclude: [".arena/**", ".git/**"]
    },
    tmux: {
      sessionName: "missing-session",
      attach: false
    },
    agents: [
      {
        id: "red-captain",
        name: "Codex Red",
        codename: "Nova",
        teamId: "red",
        teamName: "Team Red",
        captainAgentId: "red-captain",
        isCaptain: true,
        command: "fake-red-captain",
        configuredGoalMode: "prompt",
        launchMode: "prompt",
        resources: [],
        teamResources: [],
        workspace: captainWorkspace,
        branch: "red-captain",
        goalFile: path.join(captainWorkspace, ".arena", "goal.md"),
        briefFile: path.join(captainWorkspace, ".arena", "brief.md"),
        claimScript: path.join(captainWorkspace, ".arena", "claim.sh"),
        claimCommand: "claim-red-captain",
        chatScript: path.join(captainWorkspace, ".arena", "chat.sh"),
        chatCommand: "chat-red-captain",
        chatInboxCommand: "chat-red-captain inbox",
        chatHistoryCommand: "chat-red-captain history",
        proposePatchScript: path.join(captainWorkspace, ".arena", "propose-patch.sh"),
        proposePatchCommand: "proposal-red-captain",
        applyProposalScript: path.join(captainWorkspace, ".arena", "apply-proposal.sh"),
        applyProposalCommand: "apply-red-captain",
        rivalsDir: path.join(captainWorkspace, ".arena", "rivals"),
        rivalDirs: {
          "blue-captain": path.join(captainWorkspace, ".arena", "rivals", "blue-captain")
        }
      },
      {
        id: "red-worker",
        name: "Claude Red",
        codename: "Ada",
        teamId: "red",
        teamName: "Team Red",
        captainAgentId: "red-captain",
        isCaptain: false,
        command: "fake-red-worker",
        configuredGoalMode: "prompt",
        launchMode: "prompt",
        resources: [],
        teamResources: [],
        workspace: workerWorkspace,
        branch: "red-worker",
        goalFile: path.join(workerWorkspace, ".arena", "goal.md"),
        briefFile: path.join(workerWorkspace, ".arena", "brief.md"),
        claimScript: path.join(workerWorkspace, ".arena", "claim.sh"),
        claimCommand: "claim-red-worker",
        chatScript: path.join(workerWorkspace, ".arena", "chat.sh"),
        chatCommand: "chat-red-worker",
        chatInboxCommand: "chat-red-worker inbox",
        chatHistoryCommand: "chat-red-worker history",
        proposePatchScript: path.join(workerWorkspace, ".arena", "propose-patch.sh"),
        proposePatchCommand: "proposal-red-worker",
        applyProposalScript: path.join(workerWorkspace, ".arena", "apply-proposal.sh"),
        applyProposalCommand: "apply-red-worker",
        rivalsDir: path.join(workerWorkspace, ".arena", "rivals"),
        rivalDirs: {
          "blue-captain": path.join(workerWorkspace, ".arena", "rivals", "blue-captain")
        }
      },
      {
        id: "blue-captain",
        name: "Codex Blue",
        codename: "Kai",
        teamId: "blue",
        teamName: "Team Blue",
        captainAgentId: "blue-captain",
        isCaptain: true,
        command: "fake-blue-captain",
        configuredGoalMode: "prompt",
        launchMode: "prompt",
        resources: [],
        teamResources: [],
        workspace: blueWorkspace,
        branch: "blue-captain",
        goalFile: path.join(blueWorkspace, ".arena", "goal.md"),
        briefFile: path.join(blueWorkspace, ".arena", "brief.md"),
        claimScript: path.join(blueWorkspace, ".arena", "claim.sh"),
        claimCommand: "claim-blue-captain",
        chatScript: path.join(blueWorkspace, ".arena", "chat.sh"),
        chatCommand: "chat-blue-captain",
        chatInboxCommand: "chat-blue-captain inbox",
        chatHistoryCommand: "chat-blue-captain history",
        proposePatchScript: path.join(blueWorkspace, ".arena", "propose-patch.sh"),
        proposePatchCommand: "proposal-blue-captain",
        applyProposalScript: path.join(blueWorkspace, ".arena", "apply-proposal.sh"),
        applyProposalCommand: "apply-blue-captain",
        rivalsDir: path.join(blueWorkspace, ".arena", "rivals"),
        rivalDirs: {
          "red-captain": path.join(blueWorkspace, ".arena", "rivals", "red-captain")
        }
      }
    ],
    claims: []
  };

  await writeRunState(state);
  return state;
}

describe("claim verification", () => {
  it("keeps running after a failed early claim", async () => {
    const state = await makeState();

    const failed = await claimRun({
      runId: state.runId,
      agentId: "a",
      statePath: state.statePath
    });

    expect(failed.status).toBe("failed");

    await fs.writeFile(path.join(state.agents[1].workspace, "pass"), "ok\n");

    const passed = await claimRun({
      runId: state.runId,
      agentId: "b",
      statePath: state.statePath
    });

    expect(passed.status).toBe("passed");
    const finalState = JSON.parse(await fs.readFile(state.statePath, "utf8")) as RunState;
    expect(finalState.status).toBe("finished");
    expect(finalState.winner?.agentId).toBe("b");
    expect(finalState.claims.map((claim) => claim.status)).toEqual(["failed", "passed"]);
  });

  it("allows only one winner for simultaneous passing claims", async () => {
    const state = await makeState();
    await fs.writeFile(path.join(state.agents[0].workspace, "pass"), "ok\n");
    await fs.writeFile(path.join(state.agents[1].workspace, "pass"), "ok\n");

    const claims = await Promise.all([
      claimRun({ runId: state.runId, agentId: "a", statePath: state.statePath }),
      claimRun({ runId: state.runId, agentId: "b", statePath: state.statePath })
    ]);

    expect(claims.filter((claim) => claim.status === "passed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "ignored")).toHaveLength(1);
    expect(claims.find((claim) => claim.status === "ignored")?.exitCode).toBe(1);

    const finalState = JSON.parse(await fs.readFile(state.statePath, "utf8")) as RunState;
    expect(finalState.winner).toBeDefined();
    expect(finalState.claims).toHaveLength(2);
  });

  it("rejects later claims after a verifier run already has a winner", async () => {
    const state = await makeState();
    await fs.writeFile(path.join(state.agents[0].workspace, "pass"), "ok\n");
    await fs.writeFile(path.join(state.agents[1].workspace, "pass"), "ok\n");

    const passed = await claimRun({
      runId: state.runId,
      agentId: "a",
      statePath: state.statePath
    });
    expect(passed.status).toBe("passed");

    const ignored = await claimRun({
      runId: state.runId,
      agentId: "b",
      statePath: state.statePath
    });

    expect(ignored.status).toBe("ignored");
    expect(ignored.exitCode).toBe(1);
    expect(ignored.note).toContain("Run already finished");

    const finalState = JSON.parse(await fs.readFile(state.statePath, "utf8")) as RunState;
    expect(finalState.status).toBe("finished");
    expect(finalState.winner?.agentId).toBe("a");
    expect(finalState.claims.map((claim) => claim.status)).toEqual(["passed", "ignored"]);
  });

  it("records manual claims as pending and keeps the run active", async () => {
    const state = await makeState("manual");

    const claim = await claimRun({
      runId: state.runId,
      agentId: "a",
      statePath: state.statePath
    });

    expect(claim.status).toBe("pending");
    expect(claim.note).toMatch(/Wait for user judgment/);

    const pendingState = JSON.parse(await fs.readFile(state.statePath, "utf8")) as RunState;
    expect(pendingState.status).toBe("running");
    expect(pendingState.winner).toBeUndefined();
    expect(pendingState.competitionStatus?.lastDirectorUpdate).toBeDefined();

    const scoreboard = await fs.readFile(path.join(state.agents[0].workspace, ".arena", "scoreboard.md"), "utf8");
    expect(scoreboard).toContain("Pending Claims");
    expect(scoreboard).toContain("a at ");
  });

  it("accepts an agent's latest pending manual claim as the winner", async () => {
    const state = await makeState("manual");
    await claimRun({ runId: state.runId, agentId: "a", statePath: state.statePath });

    const accepted = await acceptManualClaim({
      runId: state.runId,
      agentId: "a",
      statePath: state.statePath
    });

    expect(accepted.status).toBe("accepted");

    const finalState = JSON.parse(await fs.readFile(state.statePath, "utf8")) as RunState;
    expect(finalState.status).toBe("finished");
    expect(finalState.winner?.agentId).toBe("a");
    expect(finalState.claims.map((claim) => claim.status)).toEqual(["accepted"]);
  });

  it("marks rival pending claims ignored when a claim is accepted", async () => {
    const state = await makeState("manual");
    await claimRun({ runId: state.runId, agentId: "a", statePath: state.statePath });
    await claimRun({ runId: state.runId, agentId: "b", statePath: state.statePath });

    await acceptManualClaim({ runId: state.runId, agentId: "a", statePath: state.statePath });

    const finalState = JSON.parse(await fs.readFile(state.statePath, "utf8")) as RunState;
    // A finished run can never judge the rival's claim; leaving it "pending"
    // kept a stale judge banner/badge alive in the overseer.
    const rival = finalState.claims.find((claim) => claim.agentId === "b");
    expect(rival?.status).toBe("ignored");
    expect(rival?.note).toMatch(/finished before this claim was judged/);
    expect(finalState.claims.find((claim) => claim.agentId === "a")?.status).toBe("accepted");
  });

  it("records captain manual claims with team winners", async () => {
    const state = await makeTeamState();

    const claim = await claimRun({
      runId: state.runId,
      agentId: "red-captain",
      statePath: state.statePath
    });

    expect(claim.status).toBe("pending");
    expect(claim.teamId).toBe("red");

    const accepted = await acceptManualClaim({
      runId: state.runId,
      agentId: "red-captain",
      statePath: state.statePath
    });
    expect(accepted.status).toBe("accepted");

    const finalState = JSON.parse(await fs.readFile(state.statePath, "utf8")) as RunState;
    expect(finalState.winner?.teamId).toBe("red");
    expect(finalState.winner?.agentId).toBe("red-captain");
  });

  it("rejects a pending manual claim and keeps the run going", async () => {
    const state = await makeState("manual");
    await claimRun({ runId: state.runId, agentId: "a", statePath: state.statePath });

    const rejected = await rejectManualClaim({
      runId: state.runId,
      agentId: "a",
      statePath: state.statePath,
      note: "Tests are still failing"
    });

    expect(rejected.status).toBe("rejected");
    expect(rejected.note).toContain("Tests are still failing");

    const afterState = JSON.parse(await fs.readFile(state.statePath, "utf8")) as RunState;
    expect(afterState.status).toBe("running");
    expect(afterState.winner).toBeUndefined();
    expect(afterState.claims.map((claim) => claim.status)).toEqual(["rejected"]);

    // A rejected agent can claim again and still win.
    await claimRun({ runId: state.runId, agentId: "a", statePath: state.statePath });
    const accepted = await acceptManualClaim({ runId: state.runId, agentId: "a", statePath: state.statePath });
    expect(accepted.status).toBe("accepted");
  });

  it("refuses to reject when there is no pending claim", async () => {
    const state = await makeState("manual");
    await expect(
      rejectManualClaim({ runId: state.runId, agentId: "a", statePath: state.statePath })
    ).rejects.toThrow(/No pending manual claim/);
  });

  it("blocks non-captain final claims with proposal guidance", async () => {
    const state = await makeTeamState();

    const claim = await claimRun({
      runId: state.runId,
      agentId: "red-worker",
      statePath: state.statePath
    });

    expect(claim.status).toBe("ignored");
    expect(claim.exitCode).toBe(1);
    expect(claim.teamId).toBe("red");
    expect(claim.note).toContain("Only team captain red-captain");

    const finalState = JSON.parse(await fs.readFile(state.statePath, "utf8")) as RunState;
    expect(finalState.status).toBe("running");
    expect(finalState.winner).toBeUndefined();
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// A state whose workspaces are real git worktrees, so verification runs in a
// clean detached checkout instead of the live workspace.
async function makeGitState(judging: RunState["judging"]): Promise<RunState> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-arena-claim-git-"));
  tempDirs.push(root);

  const repoRoot = path.join(root, "repo");
  await fs.mkdir(repoRoot, { recursive: true });
  git(repoRoot, ["init", "-b", "main"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  git(repoRoot, ["config", "user.email", "test@example.invalid"]);
  await fs.writeFile(path.join(repoRoot, "check.sh"), "test -f pass\n", "utf8");
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "init"]);
  const baseRef = git(repoRoot, ["rev-parse", "HEAD"]);

  const state = await makeState("verifier");
  state.baseRepo = repoRoot;
  state.baseRef = baseRef;
  state.judging = judging;
  state.verifyCommand = judging.mode === "verifier" ? judging.verifyCommand : undefined;

  for (const agent of state.agents) {
    // Replace the plain-directory workspace with a real worktree.
    await fs.rm(agent.workspace, { recursive: true, force: true });
    git(repoRoot, ["worktree", "add", "-b", `arena/${agent.id}`, agent.workspace, baseRef]);
    agent.branch = `arena/${agent.id}`;
    await fs.mkdir(path.join(agent.workspace, ".arena", "rivals"), { recursive: true });
  }

  await writeRunState(state);
  return state;
}

describe("clean-checkout verification", () => {
  it("verifies uncommitted work in a detached snapshot and cleans up", async () => {
    const state = await makeGitState({ mode: "verifier", verifyCommand: "test -f pass" });
    await fs.writeFile(path.join(state.agents[0].workspace, "pass"), "ok\n");

    const claim = await claimRun({ runId: state.runId, agentId: "a", statePath: state.statePath });

    expect(claim.status).toBe("passed");
    expect(claim.note).toContain("clean checkout");
    // The agent's own HEAD and index were not touched by the snapshot.
    expect(git(state.agents[0].workspace, ["status", "--porcelain"])).toContain("pass");
    expect(git(state.agents[0].workspace, ["rev-parse", "HEAD"])).toBe(state.baseRef);
    // No verify worktree left behind.
    const leftovers = (await fs.readdir(state.runDir)).filter((entry) => entry.startsWith("verify-"));
    expect(leftovers.filter((entry) => entry !== "verify-index")).toEqual([]);
  });

  it("restores protectedPaths from baseRef so edited verifiers cannot cheat", async () => {
    const state = await makeGitState({
      mode: "verifier",
      verifyCommand: "sh check.sh",
      protectedPaths: ["check.sh"]
    });
    // The agent tries to game the verifier instead of creating the pass file.
    await fs.writeFile(path.join(state.agents[0].workspace, "check.sh"), "exit 0\n", "utf8");

    const cheated = await claimRun({ runId: state.runId, agentId: "a", statePath: state.statePath });
    expect(cheated.status).toBe("failed");

    // Honest work still passes with the protected verifier.
    await fs.writeFile(path.join(state.agents[1].workspace, "pass"), "ok\n");
    const honest = await claimRun({ runId: state.runId, agentId: "b", statePath: state.statePath });
    expect(honest.status).toBe("passed");
  });

  it("lets edited verifiers win when no protectedPaths are set", async () => {
    const state = await makeGitState({ mode: "verifier", verifyCommand: "sh check.sh" });
    await fs.writeFile(path.join(state.agents[0].workspace, "check.sh"), "exit 0\n", "utf8");

    const claim = await claimRun({ runId: state.runId, agentId: "a", statePath: state.statePath });

    expect(claim.status).toBe("passed");
  });
});
