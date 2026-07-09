import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { notifyRivalsOfClaim, updateCompetitionArtifacts } from "./competition.js";
import { refreshAllMirrors } from "./mirror.js";
import { readRunState, resolveStatePath, withRunLock, writeRunState } from "./run-state.js";
import { runCheckedRaw, runShell } from "./shell.js";
import { sendTmuxPaneCtrlC, sendTmuxPaneText } from "./tmux.js";
import type { ClaimRecord, RunAgent, RunState, ShellResult } from "./types.js";

export type ClaimRunOptions = {
  runId: string;
  agentId: string;
  statePath?: string;
};

export type AcceptClaimOptions = ClaimRunOptions;

export type RejectClaimOptions = ClaimRunOptions & {
  note?: string;
};

function elapsedMs(state: RunState, at: Date): number {
  return at.getTime() - new Date(state.startedAt).getTime();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopOtherAgentPanes(state: RunState, winnerAgentId: string): Promise<void> {
  const paneIds = state.agents
    .filter((agent) => agent.id !== winnerAgentId)
    .map((agent) => agent.paneId)
    .filter((paneId): paneId is string => Boolean(paneId));

  if (paneIds.length === 0) {
    return;
  }

  for (const paneId of paneIds) {
    sendTmuxPaneCtrlC(paneId);
  }
  await sleep(1000);
  for (const paneId of paneIds) {
    sendTmuxPaneCtrlC(paneId);
  }
}

function gitSummary(workspace: string): string {
  try {
    // Trailing-only trims: leading spaces are part of git's status/diffstat
    // column alignment; a full trim corrupts the first line.
    const status = runCheckedRaw("git", ["-C", workspace, "status", "--short"]).replace(/\s+$/u, "");
    const diffStat = runCheckedRaw("git", ["-C", workspace, "diff", "--stat"]).replace(/\s+$/u, "");
    return [`### ${workspace}`, "", "Status:", "```", status || "(clean)", "```", "", "Diff stat:", "```", diffStat || "(no unstaged diff)", "```", ""].join("\n");
  } catch (error) {
    return `### ${workspace}\n\nCould not read git summary: ${(error as Error).message}\n`;
  }
}

async function writeFinalReport(state: RunState, claim: ClaimRecord): Promise<void> {
  const reportPath = path.join(state.runDir, "final-report.md");
  const winner = state.agents.find((agent) => agent.id === claim.agentId);
  const lines = [
    "# Agent Arena Final Report",
    "",
    `Run: ${state.runId}`,
    `Winner: ${winner?.name ?? claim.agentId}`,
    `Finished: ${state.finishedAt}`,
    "",
    "## Goal",
    "",
    state.goal,
    "",
    "## Winning Claim Output",
    "",
    "stdout:",
    "```",
    claim.stdout.trim() || "(empty)",
    "```",
    "",
    "stderr:",
    "```",
    claim.stderr.trim() || "(empty)",
    "```",
    "",
    "## Agent Workspaces",
    "",
    ...state.agents.flatMap((agent) => [`- ${agent.name}: ${agent.workspace}`]),
    "",
    "## Git Summaries",
    "",
    ...state.agents.map((agent) => gitSummary(agent.workspace))
  ];

  await fs.writeFile(reportPath, `${lines.join("\n")}\n`, "utf8");
}

type GitResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runGit(cwd: string, args: string[], env?: Record<string, string>): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : undefined
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function gitChecked(cwd: string, args: string[], env?: Record<string, string>): string {
  const result = runGit(cwd, args, env);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed with exit ${result.status ?? "unknown"}\n${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

// Arena runtime files and likely secrets stay out of verification snapshots.
const VERIFY_SNAPSHOT_EXCLUDES = [
  ":(exclude).arena/**",
  ":(exclude).agent-arena/**",
  ":(exclude)node_modules/**",
  ":(exclude).env",
  ":(exclude).env.*",
  ":(exclude)*.pem",
  ":(exclude)*.key"
];

function isGitWorkspace(workspace: string): boolean {
  return runGit(workspace, ["rev-parse", "--git-dir"]).status === 0;
}

// Builds a commit of the workspace's current contents without touching the
// agent's HEAD, index, or working tree, using a throwaway index file.
function snapshotWorkspaceCommit(workspace: string, tmpDir: string, message: string): string {
  const indexFile = path.join(tmpDir, "verify-index");
  const env = { GIT_INDEX_FILE: indexFile };
  gitChecked(workspace, ["read-tree", "HEAD"], env);
  gitChecked(workspace, ["add", "-A", "--", ".", ...VERIFY_SNAPSHOT_EXCLUDES], env);
  const tree = gitChecked(workspace, ["write-tree"], env);
  const head = gitChecked(workspace, ["rev-parse", "HEAD"]);
  return gitChecked(workspace, ["commit-tree", tree, "-p", head, "-m", message], {
    ...env,
    GIT_AUTHOR_NAME: "Agent Arena",
    GIT_AUTHOR_EMAIL: "arena@agent-arena.invalid",
    GIT_COMMITTER_NAME: "Agent Arena",
    GIT_COMMITTER_EMAIL: "arena@agent-arena.invalid"
  });
}

// Restore paths the agent must not control from the run's base ref. A
// protected path added by the agent (absent from baseRef) is removed instead.
async function restoreProtectedPaths(verifyDir: string, baseRef: string, protectedPaths: string[]): Promise<void> {
  for (const protectedPath of protectedPaths) {
    const restored = runGit(verifyDir, ["checkout", baseRef, "--", protectedPath]);
    if (restored.status !== 0) {
      await fs.rm(path.join(verifyDir, protectedPath), { recursive: true, force: true });
    }
  }
}

type VerificationOutcome = {
  result: ShellResult;
  note?: string;
};

// Runs the verifier in a pristine detached checkout of a snapshot of the
// claimant's workspace, so leftover process state, chmod tricks, or (with
// protectedPaths) edited tests cannot influence the verdict. Non-git
// workspaces (legacy configs, tests) fall back to in-place verification.
async function runVerification(state: RunState, agent: RunAgent, verifyCommand: string): Promise<VerificationOutcome> {
  if (!isGitWorkspace(agent.workspace)) {
    return {
      result: await runShell(verifyCommand, agent.workspace),
      note: "Verified in place: workspace is not a git checkout."
    };
  }

  const protectedPaths = state.judging.mode === "verifier" ? state.judging.protectedPaths ?? [] : [];
  const verifyDir = path.join(state.runDir, `verify-${agent.id}-${Date.now()}`);
  await fs.mkdir(state.runDir, { recursive: true });

  const commit = snapshotWorkspaceCommit(
    agent.workspace,
    state.runDir,
    `Agent Arena verification snapshot for ${agent.id} (run ${state.runId})`
  );

  // The agent workspace shares its object store with the base repo, so the
  // snapshot commit is visible there and can host the temporary worktree.
  gitChecked(state.baseRepo, ["worktree", "add", "--detach", verifyDir, commit]);
  try {
    await restoreProtectedPaths(verifyDir, state.baseRef, protectedPaths);
    const result = await runShell(verifyCommand, verifyDir);
    return {
      result,
      note: `Verified in a clean checkout of snapshot ${commit.slice(0, 12)}.`
    };
  } finally {
    const removed = runGit(state.baseRepo, ["worktree", "remove", "--force", verifyDir]);
    if (removed.status !== 0) {
      await fs.rm(verifyDir, { recursive: true, force: true });
      runGit(state.baseRepo, ["worktree", "prune"]);
    }
  }
}

function notifyRivalsOfManualClaim(state: RunState, claimantId: string): void {
  if (state.judging.mode !== "manual") {
    return;
  }
  notifyRivalsOfClaim(state, claimantId);
}

async function claimManualRun(state: RunState, agentId: string, claimedAt: string): Promise<ClaimRecord> {
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  const claim: ClaimRecord = {
    agentId,
    teamId: agent?.teamId,
    claimedAt,
    verifiedAt: claimedAt,
    status: "pending",
    exitCode: 0,
    stdout: "",
    stderr: "",
    note: "Manual finish claim recorded. Wait for user judgment while rivals continue competing."
  };

  state.claims.push(claim);
  await refreshAllMirrors(state);
  await updateCompetitionArtifacts(state);
  notifyRivalsOfManualClaim(state, agentId);
  await writeRunState(state);
  return claim;
}

export async function claimRun(options: ClaimRunOptions): Promise<ClaimRecord> {
  const statePath = await resolveStatePath(options.runId, options.statePath);

  return withRunLock(statePath, async () => {
    const state = await readRunState(statePath);
    const agent = state.agents.find((candidate) => candidate.id === options.agentId);

    if (!agent) {
      throw new Error(`Unknown agent ${options.agentId} for run ${options.runId}.`);
    }

    const claimedAtDate = new Date();
    const claimedAt = claimedAtDate.toISOString();

    if (state.status !== "running" || state.winner) {
      const claim: ClaimRecord = {
        agentId: options.agentId,
        teamId: agent.teamId,
        claimedAt,
        verifiedAt: claimedAt,
        status: "ignored",
        stdout: "",
        stderr: "",
        exitCode: 1,
        note: `Run already finished${state.winner ? `; winner is ${state.winner.agentId}` : ""}.`
      };
      state.claims.push(claim);
      await updateCompetitionArtifacts(state);
      await writeRunState(state);
      return claim;
    }

    if (agent.isCaptain === false) {
      const claim: ClaimRecord = {
        agentId: options.agentId,
        teamId: agent.teamId,
        claimedAt,
        verifiedAt: claimedAt,
        status: "ignored",
        exitCode: 1,
        stdout: "",
        stderr: "",
        note: `Only team captain ${agent.captainAgentId} can submit final claims for ${agent.teamName}.`
      };
      state.claims.push(claim);
      await updateCompetitionArtifacts(state);
      await writeRunState(state);
      return claim;
    }

    if (state.judging.mode === "manual") {
      return claimManualRun(state, options.agentId, claimedAt);
    }

    const started = Date.now();
    const verification = await runVerification(state, agent, state.judging.verifyCommand);
    const result = verification.result;
    const verifiedAtDate = new Date();
    const claim: ClaimRecord = {
      agentId: options.agentId,
      teamId: agent.teamId,
      claimedAt,
      verifiedAt: verifiedAtDate.toISOString(),
      status: result.exitCode === 0 ? "passed" : "failed",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - started,
      note: verification.note
    };

    state.claims.push(claim);

    if (claim.status === "passed") {
      const verifiedAt = claim.verifiedAt ?? verifiedAtDate.toISOString();
      state.status = "finished";
      state.finishedAt = verifiedAt;
      state.winner = {
        teamId: agent.teamId,
        agentId: options.agentId,
        claimedAt,
        verifiedAt,
        elapsedMs: elapsedMs(state, verifiedAtDate)
      };
      await refreshAllMirrors(state);
      await writeFinalReport(state, claim);
      await stopOtherAgentPanes(state, options.agentId);
    }

    await updateCompetitionArtifacts(state);
    await writeRunState(state);
    return claim;
  });
}

export async function rejectManualClaim(options: RejectClaimOptions): Promise<ClaimRecord> {
  const statePath = await resolveStatePath(options.runId, options.statePath);

  return withRunLock(statePath, async () => {
    const state = await readRunState(statePath);
    const agent = state.agents.find((candidate) => candidate.id === options.agentId);

    if (!agent) {
      throw new Error(`Unknown agent ${options.agentId} for run ${options.runId}.`);
    }

    if (state.judging.mode !== "manual") {
      throw new Error("Manual claim rejection is only available for manual judging runs.");
    }

    const claim = [...state.claims].reverse().find((candidate) => {
      return candidate.agentId === options.agentId && candidate.status === "pending";
    });

    if (!claim) {
      throw new Error(`No pending manual claim found for agent ${options.agentId}.`);
    }

    const rejectedAt = new Date().toISOString();
    claim.status = "rejected";
    claim.verifiedAt = rejectedAt;
    claim.note = options.note?.trim() ? `Rejected by user: ${options.note.trim()}` : "Rejected by user.";

    sendTmuxPaneText(
      agent.paneId,
      `ARENA JUDGE: Your finish claim was rejected.${options.note?.trim() ? ` Reason: ${options.note.trim()}.` : ""} Keep working and claim again with ./.arena/claim.sh when ready.`
    );

    await updateCompetitionArtifacts(state);
    await writeRunState(state);
    return claim;
  });
}

export async function acceptManualClaim(options: AcceptClaimOptions): Promise<ClaimRecord> {
  const statePath = await resolveStatePath(options.runId, options.statePath);

  return withRunLock(statePath, async () => {
    const state = await readRunState(statePath);
    const agent = state.agents.find((candidate) => candidate.id === options.agentId);

    if (!agent) {
      throw new Error(`Unknown agent ${options.agentId} for run ${options.runId}.`);
    }

    if (state.judging.mode !== "manual") {
      throw new Error("Manual claim acceptance is only available for manual judging runs.");
    }

    if (state.winner) {
      throw new Error(`Run already won by ${state.winner.agentId}.`);
    }

    const claim = [...state.claims].reverse().find((candidate) => {
      return candidate.agentId === options.agentId && candidate.status === "pending";
    });

    if (!claim) {
      throw new Error(`No pending manual claim found for agent ${options.agentId}.`);
    }

    const acceptedAtDate = new Date();
    const acceptedAt = acceptedAtDate.toISOString();
    claim.status = "accepted";
    claim.verifiedAt = acceptedAt;
    claim.exitCode = 0;
    claim.note = "Accepted by user.";

    state.status = "finished";
    state.finishedAt = acceptedAt;
    state.winner = {
      teamId: agent.teamId,
      agentId: options.agentId,
      claimedAt: claim.claimedAt,
      verifiedAt: acceptedAt,
      elapsedMs: elapsedMs(state, acceptedAtDate)
    };

    await refreshAllMirrors(state);
    await updateCompetitionArtifacts(state);
    await writeFinalReport(state, claim);
    await stopOtherAgentPanes(state, options.agentId);
    await writeRunState(state);
    return claim;
  });
}
