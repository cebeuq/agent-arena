import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatElapsed, pluralize } from "./format.js";
import { runCheckedRaw } from "./shell.js";
import { sendTmuxPaneText } from "./tmux.js";
import type { RunAgent, RunState } from "./types.js";

export const NOTICE_INTERVAL_SECONDS = 180;

export type AgentProgress = {
  agentId: string;
  name: string;
  changedFiles: string[];
  diffStat: string;
  claimCount: number;
  latestClaimStatus?: string;
  latestClaimAt?: string;
};

export type NoticeSender = (paneId: string | undefined, message: string) => void;

function nowIso(now: Date): string {
  return now.toISOString();
}

function elapsedMs(state: RunState, now: Date): number {
  const start = new Date(state.startedAt).getTime();
  return Math.max(0, now.getTime() - start);
}

function latestClaimForAgent(state: RunState, agentId: string) {
  return [...state.claims].reverse().find((claim) => claim.agentId === agentId);
}

function cleanStatusPath(statusLine: string): string {
  const pathPart = statusLine.slice(3).trim();
  const renamed = pathPart.split(" -> ");
  return renamed[renamed.length - 1] ?? pathPart;
}

function isArenaInternal(relPath: string): boolean {
  return (
    relPath === ".arena" ||
    relPath.startsWith(".arena/") ||
    relPath === ".agent-arena" ||
    relPath.startsWith(".agent-arena/") ||
    relPath === ".git" ||
    relPath.startsWith(".git/")
  );
}

function workspaceGitOutput(agent: RunAgent, args: string[]): string {
  try {
    // Raw variant: a blob-trim would strip the first status line's leading
    // space and corrupt the first changed-file path (see cleanStatusPath).
    return runCheckedRaw("git", ["-C", agent.workspace, ...args]);
  } catch {
    return "";
  }
}

function parseAgentProgress(state: RunState, agent: RunAgent, statusOutput: string, diffStat: string): AgentProgress {
  const changedFiles = statusOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map(cleanStatusPath)
    .filter((relPath) => !isArenaInternal(relPath));
  const latestClaim = latestClaimForAgent(state, agent.id);

  return {
    agentId: agent.id,
    name: `${agent.codename ?? agent.name} (${agent.id})`,
    changedFiles,
    // Trailing-only trim: `git diff --stat` lines begin with a space that
    // keeps the column alignment, so a full trim would misalign the first row.
    diffStat: diffStat.replace(/\s+$/u, ""),
    claimCount: state.claims.filter((claim) => claim.agentId === agent.id).length,
    latestClaimStatus: latestClaim?.status,
    latestClaimAt: latestClaim?.verifiedAt ?? latestClaim?.claimedAt
  };
}

export function collectAgentProgress(state: RunState): AgentProgress[] {
  return state.agents.map((agent) =>
    parseAgentProgress(
      state,
      agent,
      workspaceGitOutput(agent, ["status", "--short", "--untracked-files=all"]),
      workspaceGitOutput(agent, ["diff", "--stat"])
    )
  );
}

const execFileAsync = promisify(execFile);

async function workspaceGitOutputAsync(agent: RunAgent, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", agent.workspace, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 8
    });
    // Do NOT trim the blob: `git status --short` lines start with a meaningful
    // status column (e.g. " M path"), and a whole-output trim would strip the
    // first line's leading space, making cleanStatusPath eat a path character.
    return result.stdout;
  } catch {
    return "";
  }
}

// Non-blocking variant for live UIs: the sync version spawns git on the calling
// thread, which would jank an interactive render loop.
export async function collectAgentProgressAsync(state: RunState): Promise<AgentProgress[]> {
  return Promise.all(
    state.agents.map(async (agent) => {
      const [statusOutput, diffStat] = await Promise.all([
        workspaceGitOutputAsync(agent, ["status", "--short", "--untracked-files=all"]),
        workspaceGitOutputAsync(agent, ["diff", "--stat"])
      ]);
      return parseAgentProgress(state, agent, statusOutput, diffStat);
    })
  );
}

const AWARENESS_TEXT =
  "Rival mirrors are optional tactical context. Inspect them when it would naturally help: if stuck, after a rival claim, before final claim, or to compare approaches. Do not spend time on them if your current path is clearly productive.";

function competitionGuide(state: RunState, agent: RunAgent): string {
  return [
    "# Agent Arena Competition",
    "",
    `You are ${agent.codename ?? agent.name} (${agent.id}) on ${agent.teamName ?? agent.name}. You are racing the other teams in run ${state.runId}.`,
    "",
    `- Claim command: ${agent.claimCommand}`,
    `- Team captain: ${agent.captainAgentId ?? agent.id}`,
    `- Scoreboard: .arena/scoreboard.md`,
    `- Rival summary: .arena/rival-summary.md`,
    "",
    "## Rival Mirrors",
    "",
    AWARENESS_TEXT,
    "",
    "Rival mirrors are read-only. Never edit, delete, or damage them.",
    "",
    "## Winning Behavior",
    "",
    "- Keep making measurable progress toward the goal.",
    "- Use the scoreboard to stay aware of claims and run status.",
    "- Claim when ready; if another agent claims first, keep improving unless the run is finished.",
    ""
  ].join("\n");
}

function scoreboardForAgent(state: RunState, agent: RunAgent, progress: AgentProgress[], now: Date): string {
  const pendingClaims = state.claims.filter((claim) => claim.status === "pending");
  const teams = state.teams ?? state.agents.map((candidate) => ({
    id: candidate.teamId ?? candidate.id,
    name: candidate.teamName ?? candidate.name,
    captainAgentId: candidate.captainAgentId ?? candidate.id,
    agentIds: [candidate.id],
    resources: []
  }));
  return [
    "# Agent Arena Scoreboard",
    "",
    `Last update: ${nowIso(now)}`,
    `Run: ${state.runId}`,
    `Status: ${state.status}`,
    `Elapsed: ${formatElapsed(elapsedMs(state, now))}`,
    `Judging: ${state.judging.mode}`,
    "",
    "## Teams",
    "",
    ...teams.flatMap((team) => [
      `### ${team.name} (${team.id})`,
      "",
      `Captain: ${team.captainAgentId}`,
      ...team.agentIds.map((agentId) => {
        const item = progress.find((candidate) => candidate.agentId === agentId);
        const latest = item?.latestClaimStatus ? `, latest claim: ${item.latestClaimStatus}` : "";
        return `- ${item?.name ?? agentId}: ${pluralize(item?.changedFiles.length ?? 0, "changed file")}, ${pluralize(item?.claimCount ?? 0, "claim")}${latest}`;
      }),
      ""
    ]),
    "",
    "## Pending Claims",
    "",
    ...(pendingClaims.length > 0
      ? pendingClaims.map((claim) => `- ${claim.agentId} at ${claim.claimedAt}`)
      : ["- None."]),
    "",
    "## Rival Mirrors",
    "",
    ...Object.entries(agent.rivalDirs).map(([rivalId, rivalDir]) => `- ${rivalId}: ${rivalDir}`),
    ""
  ].join("\n");
}

function rivalSummaryForAgent(state: RunState, agent: RunAgent, progress: AgentProgress[]): string {
  const rivals = state.agents.filter((candidate) => candidate.id !== agent.id);
  const byAgent = new Map(progress.map((item) => [item.agentId, item]));

  return [
    "# Agent Arena Rival Summary",
    "",
    "This is compact context. Use it only when it helps your current path.",
    "",
    ...rivals.flatMap((rival) => {
      const item = byAgent.get(rival.id);
      const files = item?.changedFiles.slice(0, 12) ?? [];
      return [
        `## ${rival.name} (${rival.id})`,
        "",
        `Team: ${rival.teamName ?? rival.teamId ?? rival.id}`,
        `Codename: ${rival.codename ?? rival.name}`,
        `Mirror: ${agent.rivalDirs[rival.id] ?? "(not available)"}`,
        `Claims: ${item?.claimCount ?? 0}${item?.latestClaimStatus ? `, latest: ${item.latestClaimStatus}` : ""}`,
        "",
        "Changed files:",
        ...(files.length > 0 ? files.map((file) => `- ${file}`) : ["- None detected."]),
        "",
        "Diff stat:",
        "```",
        item?.diffStat || "(no tracked diff stat)",
        "```",
        ""
      ];
    })
  ].join("\n");
}

export async function writeCompetitionFilesForAgent(
  state: RunState,
  agent: RunAgent,
  progress: AgentProgress[] = collectAgentProgress(state),
  now: Date = new Date()
): Promise<void> {
  const arenaDir = path.dirname(agent.goalFile);
  await fs.mkdir(arenaDir, { recursive: true });
  await fs.writeFile(path.join(arenaDir, "competition.md"), `${competitionGuide(state, agent)}\n`, "utf8");
  await fs.writeFile(path.join(arenaDir, "scoreboard.md"), `${scoreboardForAgent(state, agent, progress, now)}\n`, "utf8");
  await fs.writeFile(path.join(arenaDir, "rival-summary.md"), `${rivalSummaryForAgent(state, agent, progress)}\n`, "utf8");
}

export async function updateCompetitionArtifacts(state: RunState, now: Date = new Date()): Promise<void> {
  const progress = collectAgentProgress(state);
  await Promise.all(state.agents.map((agent) => writeCompetitionFilesForAgent(state, agent, progress, now)));
  state.competitionStatus = {
    ...state.competitionStatus,
    lastDirectorUpdate: nowIso(now)
  };
}

function shouldSendPeriodicNotice(state: RunState, now: Date): boolean {
  const lastNoticeAt = state.competitionStatus?.lastNoticeAt;
  const since = lastNoticeAt ? new Date(lastNoticeAt) : new Date(state.startedAt);
  return now.getTime() - since.getTime() >= NOTICE_INTERVAL_SECONDS * 1000;
}

function periodicNotice(state: RunState, agent: RunAgent): string {
  const rivals = (state.teams ?? [])
    .filter((team) => team.id !== agent.teamId)
    .map((team) => team.name)
    .join(", ");
  const rivalText = rivals || "the other agents";

  return `ARENA UPDATE: ${agent.codename ?? agent.name}, race still running against ${rivalText}. Check .arena/scoreboard.md for claims and progress. Use .arena/rival-summary.md only if it helps, then keep moving.`;
}

export function sendPeriodicCompetitionNotices(
  state: RunState,
  now: Date = new Date(),
  sender: NoticeSender = sendTmuxPaneText
): boolean {
  if (!shouldSendPeriodicNotice(state, now)) {
    return false;
  }

  for (const agent of state.agents) {
    sender(agent.paneId, periodicNotice(state, agent));
  }

  state.competitionStatus = {
    ...state.competitionStatus,
    lastNoticeAt: nowIso(now),
    lastNoticeReason: "periodic"
  };
  return true;
}

function claimNotice(claimant: RunAgent, progress: AgentProgress[]): string {
  const claimantProgress = progress.find((item) => item.agentId === claimant.id);
  const files = claimantProgress?.changedFiles.slice(0, 3).map((file) => (file.length > 42 ? `${file.slice(0, 39)}...` : file)) ?? [];
  const fileText = files.length > 0 ? files.join(", ") : "no changed files detected";
  const mirrorPath = `.arena/rivals/${claimant.id}`;
  const claimantLabel = claimant.teamName
    ? `${claimant.teamName} captain ${claimant.codename ?? claimant.name} (${claimant.id})`
    : claimant.name;

  return `ARENA CLAIM: ${claimantLabel} submitted a finish claim. Mirror: ${mirrorPath}. Changed: ${fileText}. Inspect only if useful; keep improving and claim with ./.arena/claim.sh if you are captain.`;
}

export function notifyRivalsOfClaim(
  state: RunState,
  claimantId: string,
  now: Date = new Date(),
  sender: NoticeSender = sendTmuxPaneText
): boolean {
  const claimant = state.agents.find((agent) => agent.id === claimantId);
  if (!claimant) {
    return false;
  }

  const progress = collectAgentProgress(state);
  for (const rival of state.agents) {
    const rivalTeamId = rival.teamId ?? rival.id;
    const claimantTeamId = claimant.teamId ?? claimant.id;
    if (rival.id !== claimantId && rivalTeamId !== claimantTeamId) {
      sender(rival.paneId, claimNotice(claimant, progress));
    }
  }

  state.competitionStatus = {
    ...state.competitionStatus,
    lastNoticeAt: nowIso(now),
    lastNoticeReason: `claim:${claimantId}`
  };
  return true;
}

export function sendManualPressureNotice(
  state: RunState,
  options: {
    agentId?: string;
    message?: string;
    now?: Date;
    sender?: NoticeSender;
  } = {}
): number {
  const now = options.now ?? new Date();
  const sender = options.sender ?? sendTmuxPaneText;
  const targets = options.agentId ? state.agents.filter((agent) => agent.id === options.agentId) : state.agents;

  const message =
    options.message ??
    "ARENA PRESSURE: User requested a competition update. Check .arena/scoreboard.md, keep momentum, and claim when ready.";

  for (const agent of targets) {
    sender(agent.paneId, message);
  }

  if (targets.length > 0) {
    state.competitionStatus = {
      ...state.competitionStatus,
      lastNoticeAt: nowIso(now),
      lastNoticeReason: options.agentId ? `manual:${options.agentId}` : "manual"
    };
  }

  return targets.length;
}
