import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  deregisterRun,
  listLocalRunStates,
  readRunState,
  resolveStatePath,
  withRunLock,
  writeRunState,
  type LocalRunState
} from "./run-state.js";
import { killTmuxSession, killTmuxViewSessions } from "./tmux.js";
import type { RunState } from "./types.js";

export type RunSummary = {
  runId: string;
  status: RunState["status"];
  startedAt: string;
  goal: string;
  agentCount: number;
  winnerAgentId?: string;
  harvest?: "merged" | "branch-only";
  statePath: string;
};

export async function listRuns(cwd = process.cwd()): Promise<RunSummary[]> {
  const states = await listLocalRunStates(cwd);
  return states
    .sort((left, right) => right.state.startedAt.localeCompare(left.state.startedAt))
    .map(({ state, statePath }) => ({
      runId: state.runId,
      status: state.status,
      startedAt: state.startedAt,
      goal: state.goal,
      agentCount: state.agents.length,
      winnerAgentId: state.winner?.agentId,
      harvest: state.harvest ? (state.harvest.merged ? "merged" : "branch-only") : undefined,
      statePath
    }));
}

export function formatRunsTable(runs: RunSummary[]): string {
  if (runs.length === 0) {
    return "No Agent Arena runs found.";
  }
  const lines = runs.map((run) => {
    const goal = run.goal.replaceAll(/\s+/g, " ").trim();
    const shortGoal = goal.length > 48 ? `${goal.slice(0, 45)}...` : goal;
    const outcome = run.winnerAgentId
      ? `winner: ${run.winnerAgentId}${
          run.harvest === "merged" ? " (harvested)" : run.harvest === "branch-only" ? " (harvested, not merged)" : ""
        }`
      : "";
    return [
      run.runId.padEnd(26),
      run.status.padEnd(9),
      run.startedAt.slice(0, 16).padEnd(17),
      `${run.agentCount} agent${run.agentCount === 1 ? "" : "s"}`.padEnd(9),
      shortGoal,
      outcome
    ]
      .join(" ")
      .trimEnd();
  });
  const header = ["run".padEnd(26), "status".padEnd(9), "started".padEnd(17), "agents".padEnd(9), "goal"].join(" ");
  return [header, ...lines].join("\n");
}

function killDaemon(pid: number | undefined): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export type StopRunOptions = {
  runId: string;
  statePath?: string;
};

export type StopRunResult = {
  runId: string;
  tmuxKilled: boolean;
  daemonKilled: boolean;
  alreadyStopped: boolean;
};

export async function stopRun(options: StopRunOptions): Promise<StopRunResult> {
  const statePath = await resolveStatePath(options.runId, options.statePath);

  return withRunLock(statePath, async () => {
    const state = await readRunState(statePath);
    const alreadyStopped = state.status !== "running";

    killTmuxViewSessions(state.tmux.sessionName);
    const tmuxKilled = killTmuxSession(state.tmux.sessionName);
    const daemonKilled = killDaemon(state.mirrorDaemonPid);

    if (!alreadyStopped) {
      state.status = "stopped";
      state.finishedAt = new Date().toISOString();
      await writeRunState(state);
    }

    return { runId: state.runId, tmuxKilled, daemonKilled, alreadyStopped };
  });
}

function runGit(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export type CleanRunOptions = {
  runId?: string;
  statePath?: string;
  // Clean every non-running local run instead of a single one.
  finished?: boolean;
  // Stop a still-running run before cleaning it.
  force?: boolean;
  // Also delete agent branches (the harvested/winner branch is kept).
  deleteBranches?: boolean;
  cwd?: string;
};

export type CleanedRun = {
  runId: string;
  removedWorkspaces: number;
  deletedBranches: number;
  messages: string[];
};

async function cleanSingleRun(entry: LocalRunState, options: CleanRunOptions): Promise<CleanedRun> {
  let state = entry.state;
  const messages: string[] = [];

  if (state.status === "running") {
    if (!options.force) {
      throw new Error(`Run ${state.runId} is still running. Stop it first with: arena stop --run ${state.runId} (or pass --force).`);
    }
    await stopRun({ runId: state.runId, statePath: entry.statePath });
    state = await readRunState(entry.statePath);
    messages.push(`Stopped running run ${state.runId}.`);
  } else {
    // A finished run's tmux session (and any -view- sessions) may still be
    // alive; cleaning should not leave orphaned sessions behind.
    killTmuxViewSessions(state.tmux.sessionName);
    if (killTmuxSession(state.tmux.sessionName)) {
      messages.push(`Killed leftover tmux session ${state.tmux.sessionName}.`);
    }
  }

  const repoRoot = state.baseRepo;
  let removedWorkspaces = 0;
  let deletedBranches = 0;

  for (const agent of state.agents) {
    if (await pathExists(agent.workspace)) {
      // Mirrors are chmod'd read-only, so make everything writable before
      // git tries to unlink files.
      spawnSync("chmod", ["-R", "u+w", agent.workspace], { stdio: "ignore" });
      const removed = runGit(repoRoot, ["worktree", "remove", "--force", agent.workspace]);
      if (removed.status !== 0) {
        await fs.rm(agent.workspace, { recursive: true, force: true });
      }
      removedWorkspaces += 1;
    }
    if (options.deleteBranches) {
      const isWinnerBranch = state.winner?.agentId === agent.id;
      if (isWinnerBranch && !state.harvest?.merged) {
        messages.push(`Kept winner branch ${agent.branch} (not merged into the base repo yet).`);
        continue;
      }
      const deleted = runGit(repoRoot, ["branch", "-D", agent.branch]);
      if (deleted.status === 0) {
        deletedBranches += 1;
      }
    }
  }

  // Let git forget worktrees whose directories were force-removed.
  runGit(repoRoot, ["worktree", "prune"]);

  const workspaceRoot = path.join(state.arenaRoot, "workspaces", state.runId);
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(state.runDir, { recursive: true, force: true });
  await deregisterRun(state.runId);

  messages.push(
    `Cleaned run ${state.runId}: removed ${removedWorkspaces} workspace(s)${options.deleteBranches ? `, deleted ${deletedBranches} branch(es)` : ""}.`
  );
  return { runId: state.runId, removedWorkspaces, deletedBranches, messages };
}

export async function cleanRuns(options: CleanRunOptions): Promise<CleanedRun[]> {
  if (!options.runId && !options.finished) {
    throw new Error("Pass --run <id> to clean one run, or --finished to clean every non-running run.");
  }

  if (options.runId) {
    const statePath = await resolveStatePath(options.runId, options.statePath);
    const state = await readRunState(statePath);
    return [await cleanSingleRun({ state, statePath }, options)];
  }

  const states = await listLocalRunStates(options.cwd ?? process.cwd());
  const targets = states.filter((entry) => entry.state.status !== "running");
  const cleaned: CleanedRun[] = [];
  for (const entry of targets) {
    cleaned.push(await cleanSingleRun(entry, options));
  }
  return cleaned;
}
