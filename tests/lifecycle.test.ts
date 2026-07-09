import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { cleanRuns, formatRunsTable, listRuns, stopRun } from "../src/lifecycle.js";
import { readRunState, registerRun, writeRunState } from "../src/run-state.js";
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
  repoRoot: string;
  workspace: string;
  branch: string;
  state: RunState;
};

async function makeRunFixture(status: RunState["status"] = "running"): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-arena-lifecycle-"));
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

  const branch = "agent-arena/run-1/solo";
  const workspace = path.join(repoRoot, ".agent-arena", "workspaces", "run-1", "solo");
  await fs.mkdir(path.dirname(workspace), { recursive: true });
  git(repoRoot, ["worktree", "add", "-b", branch, workspace, "HEAD"]);

  const agent = { ...makeRunAgent(repoRoot, { id: "solo", teamId: "red" }), workspace, branch };
  const runDir = path.join(repoRoot, ".agent-arena", "runs", "run-1");
  await fs.mkdir(runDir, { recursive: true });

  const state = makeRunState(repoRoot, {
    status,
    baseRepo: repoRoot,
    arenaRoot: path.join(repoRoot, ".agent-arena"),
    runDir,
    statePath: path.join(runDir, "state.json"),
    // A session name that never exists, so stop() has nothing real to kill.
    tmux: { sessionName: `arena-test-${Date.now()}`, attach: false },
    agents: [agent],
    teams: undefined
  });
  await writeRunState(state);
  await registerRun(state.runId, state.statePath);

  return { repoRoot, workspace, branch, state };
}

describe("listRuns", () => {
  it("lists registered runs with status and winner", async () => {
    const fixture = await makeRunFixture("running");
    const runs = await listRuns(fixture.repoRoot);
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe("run-1");
    expect(runs[0].status).toBe("running");
    expect(runs[0].agentCount).toBe(1);

    const table = formatRunsTable(runs);
    expect(table).toContain("run-1");
    expect(table).toContain("running");
  });

  it("renders an empty message when no runs exist", () => {
    expect(formatRunsTable([])).toContain("No Agent Arena runs");
  });
});

describe("stopRun", () => {
  it("marks a running run stopped and records finishedAt", async () => {
    const fixture = await makeRunFixture("running");

    const result = await stopRun({ runId: "run-1", statePath: fixture.state.statePath });

    expect(result.alreadyStopped).toBe(false);
    const after = await readRunState(fixture.state.statePath);
    expect(after.status).toBe("stopped");
    expect(after.finishedAt).toBeDefined();
  });

  it("is idempotent for non-running runs", async () => {
    const fixture = await makeRunFixture("finished");

    const result = await stopRun({ runId: "run-1", statePath: fixture.state.statePath });

    expect(result.alreadyStopped).toBe(true);
    const after = await readRunState(fixture.state.statePath);
    expect(after.status).toBe("finished");
  });
});

describe("cleanRuns", () => {
  it("refuses to clean a running run without --force", async () => {
    const fixture = await makeRunFixture("running");

    await expect(cleanRuns({ runId: "run-1", statePath: fixture.state.statePath })).rejects.toThrow(
      /still running/
    );
  });

  it("removes worktrees, run dir, and index entry for a finished run", async () => {
    const fixture = await makeRunFixture("finished");

    const cleaned = await cleanRuns({ runId: "run-1", statePath: fixture.state.statePath });

    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].removedWorkspaces).toBe(1);
    await expect(fs.access(fixture.workspace)).rejects.toThrow();
    await expect(fs.access(fixture.state.runDir)).rejects.toThrow();
    // Branch is kept without --branches.
    expect(git(fixture.repoRoot, ["branch", "--list", fixture.branch])).toContain(fixture.branch);
    // Deregistered: the run is no longer discoverable by id.
    await expect(cleanRuns({ runId: "run-1" })).rejects.toThrow(/Unknown run/);
  });

  it("deletes branches with --branches but keeps an unharvested winner branch", async () => {
    const fixture = await makeRunFixture("finished");
    const state = {
      ...fixture.state,
      winner: {
        agentId: "solo",
        claimedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
        elapsedMs: 5
      }
    };
    await writeRunState(state);

    const cleaned = await cleanRuns({ runId: "run-1", statePath: state.statePath, deleteBranches: true });

    expect(cleaned[0].deletedBranches).toBe(0);
    expect(cleaned[0].messages.join("\n")).toContain("Kept winner branch");
    expect(git(fixture.repoRoot, ["branch", "--list", fixture.branch])).toContain(fixture.branch);
  });

  it("stops then cleans a running run with --force", async () => {
    const fixture = await makeRunFixture("running");

    const cleaned = await cleanRuns({ runId: "run-1", statePath: fixture.state.statePath, force: true });

    expect(cleaned).toHaveLength(1);
    await expect(fs.access(fixture.workspace)).rejects.toThrow();
  });
});
