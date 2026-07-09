import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { harvestRun } from "../src/harvest.js";
import { writeRunState } from "../src/run-state.js";
import { makeRunAgent, makeRunState } from "./helpers/state.js";
import type { RunState } from "../src/types.js";

let tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.AGENT_ARENA_HOME;
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

type Fixture = {
  root: string;
  repoRoot: string;
  workspace: string;
  branch: string;
  state: RunState;
};

async function makeHarvestFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-arena-harvest-"));
  tempDirs.push(root);
  process.env.AGENT_ARENA_HOME = root;

  const repoRoot = path.join(root, "repo");
  await fs.mkdir(repoRoot, { recursive: true });
  git(repoRoot, ["init", "-b", "main"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  git(repoRoot, ["config", "user.email", "test@example.invalid"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "base\n", "utf8");
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "init"]);

  const branch = "agent-arena/run-1/winner";
  const workspace = path.join(repoRoot, ".agent-arena", "workspaces", "run-1", "winner");
  await fs.mkdir(path.dirname(workspace), { recursive: true });
  git(repoRoot, ["worktree", "add", "-b", branch, workspace, "HEAD"]);

  const winner = {
    ...makeRunAgent(repoRoot, { id: "winner", teamId: "red" }),
    workspace,
    branch
  };
  const rival = makeRunAgent(repoRoot, { id: "rival", teamId: "blue" });
  const runDir = path.join(repoRoot, ".agent-arena", "runs", "run-1");
  await fs.mkdir(runDir, { recursive: true });

  const state = makeRunState(repoRoot, {
    status: "finished",
    baseRepo: repoRoot,
    runDir,
    statePath: path.join(runDir, "state.json"),
    agents: [winner, rival],
    teams: undefined,
    winner: {
      agentId: "winner",
      claimedAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      elapsedMs: 1000
    }
  });
  await writeRunState(state);

  return { root, repoRoot, workspace, branch, state };
}

describe("harvestRun", () => {
  it("commits uncommitted winner work and merges it into the base branch", async () => {
    const fixture = await makeHarvestFixture();
    await fs.writeFile(path.join(fixture.workspace, "feature.txt"), "winner work\n", "utf8");
    await fs.mkdir(path.join(fixture.workspace, ".arena"), { recursive: true });
    await fs.writeFile(path.join(fixture.workspace, ".arena", "goal.md"), "runtime file\n", "utf8");

    const result = await harvestRun({ runId: "run-1", statePath: fixture.state.statePath });

    expect(result.record.merged).toBe(true);
    expect(result.record.targetBranch).toBe("main");
    expect(result.record.agentId).toBe("winner");

    const merged = await fs.readFile(path.join(fixture.repoRoot, "feature.txt"), "utf8");
    expect(merged).toBe("winner work\n");
    // Arena runtime files never enter the harvested commit.
    await expect(fs.access(path.join(fixture.repoRoot, ".arena"))).rejects.toThrow();

    const stateAfter = JSON.parse(await fs.readFile(fixture.state.statePath, "utf8")) as RunState;
    expect(stateAfter.harvest?.merged).toBe(true);
    expect(stateAfter.harvest?.mergeCommit).toBe(git(fixture.repoRoot, ["rev-parse", "HEAD"]));
  });

  it("supports --no-merge by only committing to the winner branch", async () => {
    const fixture = await makeHarvestFixture();
    await fs.writeFile(path.join(fixture.workspace, "feature.txt"), "branch only\n", "utf8");

    const result = await harvestRun({ runId: "run-1", statePath: fixture.state.statePath, merge: false });

    expect(result.record.merged).toBe(false);
    expect(result.messages.join("\n")).toContain(`git merge ${fixture.branch}`);
    // Base branch untouched.
    await expect(fs.access(path.join(fixture.repoRoot, "feature.txt"))).rejects.toThrow();
    // Work committed on the agent branch.
    const files = git(fixture.repoRoot, ["ls-tree", "--name-only", fixture.branch]);
    expect(files).toContain("feature.txt");
  });

  it("refuses to merge into a dirty base repo", async () => {
    const fixture = await makeHarvestFixture();
    await fs.writeFile(path.join(fixture.workspace, "feature.txt"), "work\n", "utf8");
    await fs.writeFile(path.join(fixture.repoRoot, "README.md"), "local edits\n", "utf8");

    await expect(harvestRun({ runId: "run-1", statePath: fixture.state.statePath })).rejects.toThrow(
      /uncommitted changes/
    );
  });

  it("refuses to harvest a run without a winner", async () => {
    const fixture = await makeHarvestFixture();
    const state = { ...fixture.state, winner: undefined };
    await writeRunState(state);

    await expect(harvestRun({ runId: "run-1", statePath: state.statePath })).rejects.toThrow(/no winner/);
  });

  it("refuses to harvest twice", async () => {
    const fixture = await makeHarvestFixture();
    await fs.writeFile(path.join(fixture.workspace, "feature.txt"), "work\n", "utf8");

    await harvestRun({ runId: "run-1", statePath: fixture.state.statePath });
    await expect(harvestRun({ runId: "run-1", statePath: fixture.state.statePath })).rejects.toThrow(
      /already harvested/
    );
  });
});
