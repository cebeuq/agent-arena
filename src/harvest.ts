import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readRunState, resolveStatePath, withRunLock, writeRunState } from "./run-state.js";
import type { HarvestRecord, RunState } from "./types.js";

export type HarvestOptions = {
  runId: string;
  statePath?: string;
  // When false, snapshot-commit the winner's work to its branch but do not
  // merge into the base repo's checked-out branch.
  merge?: boolean;
};

export type HarvestResult = {
  record: HarvestRecord;
  messages: string[];
};

// Arena runtime files and likely secrets never belong in the harvested branch.
const SNAPSHOT_EXCLUDES = [
  ":(exclude).arena/**",
  ":(exclude).agent-arena/**",
  ":(exclude)node_modules/**",
  ":(exclude).env",
  ":(exclude).env.*",
  ":(exclude)*.pem",
  ":(exclude)*.key"
];

// Commits are created with an explicit identity so harvest works in
// environments (CI, fresh machines) without global git config.
const GIT_IDENTITY = ["-c", "user.name=Agent Arena", "-c", "user.email=arena@agent-arena.invalid"];

type GitResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function gitChecked(cwd: string, args: string[]): string {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed with exit ${result.status ?? "unknown"}\n${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function truncatedGoal(goal: string): string {
  const singleLine = goal.replaceAll(/\s+/g, " ").trim();
  return singleLine.length > 72 ? `${singleLine.slice(0, 69)}...` : singleLine;
}

// Commits any uncommitted winner work to the agent branch. Returns the branch
// head commit, whether or not a new snapshot commit was needed.
function snapshotWorkspace(state: RunState, workspace: string): { head: string; committed: boolean } {
  const status = gitChecked(workspace, ["status", "--porcelain", "--", ".", ...SNAPSHOT_EXCLUDES]);
  if (!status) {
    return { head: gitChecked(workspace, ["rev-parse", "HEAD"]), committed: false };
  }
  gitChecked(workspace, ["add", "-A", "--", ".", ...SNAPSHOT_EXCLUDES]);
  gitChecked(workspace, [
    ...GIT_IDENTITY,
    "commit",
    "-m",
    `Agent Arena run ${state.runId}: ${truncatedGoal(state.goal)}`
  ]);
  return { head: gitChecked(workspace, ["rev-parse", "HEAD"]), committed: true };
}

function mergeIntoBaseRepo(state: RunState, branch: string): { mergeCommit: string; targetBranch: string } {
  const baseRepo = state.baseRepo;
  // Untracked files (like .agent-arena/ itself) don't block a merge; git
  // refuses on its own if the merge would overwrite one.
  const dirty = gitChecked(baseRepo, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) {
    throw new Error(
      `Base repo ${baseRepo} has uncommitted changes. Commit or stash them first, or run harvest with --no-merge and merge ${branch} yourself.`
    );
  }

  const targetBranch = gitChecked(baseRepo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (targetBranch === "HEAD") {
    throw new Error(
      `Base repo ${baseRepo} is on a detached HEAD. Check out a branch first, or run harvest with --no-merge and merge ${branch} yourself.`
    );
  }

  const merge = runGit(baseRepo, [
    ...GIT_IDENTITY,
    "merge",
    "--no-ff",
    "-m",
    `Merge Agent Arena winner (run ${state.runId}, branch ${branch})`,
    branch
  ]);
  if (merge.status !== 0) {
    // Leave the repo the way we found it; conflicts are for the user to resolve.
    runGit(baseRepo, ["merge", "--abort"]);
    throw new Error(
      `Merging ${branch} into ${targetBranch} failed (likely conflicts). The merge was aborted; resolve manually with: git merge ${branch}\n${merge.stderr.trim()}`
    );
  }

  return { mergeCommit: gitChecked(baseRepo, ["rev-parse", "HEAD"]), targetBranch };
}

async function appendToFinalReport(state: RunState, record: HarvestRecord): Promise<void> {
  const reportPath = path.join(state.runDir, "final-report.md");
  if (!(await pathExists(reportPath))) {
    return;
  }
  const lines = [
    "",
    "## Harvest",
    "",
    `Harvested: ${record.harvestedAt}`,
    `Branch: ${record.branch}`,
    `Snapshot commit: ${record.snapshotCommit}`,
    record.merged
      ? `Merged into ${record.targetBranch} as ${record.mergeCommit}`
      : "Not merged; merge manually when ready.",
    ""
  ];
  await fs.appendFile(reportPath, `${lines.join("\n")}`, "utf8");
}

export async function harvestRun(options: HarvestOptions): Promise<HarvestResult> {
  const statePath = await resolveStatePath(options.runId, options.statePath);
  const merge = options.merge ?? true;

  return withRunLock(statePath, async () => {
    const state = await readRunState(statePath);

    if (!state.winner) {
      throw new Error(`Run ${state.runId} has no winner yet. Accept a claim first, then harvest.`);
    }
    if (state.harvest?.merged) {
      throw new Error(
        `Run ${state.runId} was already harvested at ${state.harvest.harvestedAt} (merged into ${state.harvest.targetBranch} as ${state.harvest.mergeCommit}).`
      );
    }

    const winner = state.agents.find((agent) => agent.id === state.winner?.agentId);
    if (!winner) {
      throw new Error(`Winner agent ${state.winner.agentId} not found in run state.`);
    }

    const messages: string[] = [];
    let snapshotCommit: string;

    if (await pathExists(winner.workspace)) {
      const snapshot = snapshotWorkspace(state, winner.workspace);
      snapshotCommit = snapshot.head;
      messages.push(
        snapshot.committed
          ? `Committed uncommitted winner work to ${winner.branch} (${snapshotCommit.slice(0, 12)}).`
          : `Winner workspace was clean; branch ${winner.branch} is at ${snapshotCommit.slice(0, 12)}.`
      );
    } else {
      // Workspace already cleaned; the branch may still carry the work.
      const head = runGit(state.baseRepo, ["rev-parse", winner.branch]);
      if (head.status !== 0) {
        throw new Error(
          `Winner workspace ${winner.workspace} is gone and branch ${winner.branch} no longer exists. Nothing to harvest.`
        );
      }
      snapshotCommit = head.stdout.trim();
      messages.push(`Winner workspace is gone; using existing branch ${winner.branch} at ${snapshotCommit.slice(0, 12)}.`);
    }

    const record: HarvestRecord = {
      harvestedAt: new Date().toISOString(),
      agentId: winner.id,
      branch: winner.branch,
      snapshotCommit,
      merged: false
    };

    if (merge) {
      const merged = mergeIntoBaseRepo(state, winner.branch);
      record.merged = true;
      record.mergeCommit = merged.mergeCommit;
      record.targetBranch = merged.targetBranch;
      messages.push(`Merged ${winner.branch} into ${merged.targetBranch} (${merged.mergeCommit.slice(0, 12)}).`);
    } else {
      messages.push(`Skipped merge. Merge manually with: git merge ${winner.branch}`);
    }

    state.harvest = record;
    await appendToFinalReport(state, record);
    await writeRunState(state);

    return { record, messages };
  });
}
