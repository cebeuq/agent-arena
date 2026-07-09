import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeAgentBrief } from "./brief.js";
import { assignCodenames } from "./codenames.js";
import { updateCompetitionArtifacts } from "./competition.js";
import { readConfig } from "./config.js";
import { resolveAgentLaunch, type AgentLaunchResolution } from "./launch.js";
import { refreshAllMirrors } from "./mirror.js";
import { formatPreflightIssues, preflightAgents } from "./preflight.js";
import { readSecretsEnv, resourceBlockingErrors, resourceOrderWarnings, resourceWarnings } from "./resources.js";
import { registerRun, writeRunState } from "./run-state.js";
import { commandExists, shellQuote } from "./shell.js";
import { attachTmux, launchTmux, runTrustWarmup } from "./tmux.js";
import type { TerminalAttachMode } from "./terminal.js";
import type { AgentInput, RunAgent, RunState, RunTeam, TeamInput } from "./types.js";
import { createWorktree, resolveGitRef, resolveGitRoot } from "./worktree.js";
import { spawnMirrorDaemon } from "./daemon.js";

export type StartStage =
  | "preflight"
  | "resources"
  | "worktrees"
  | "verifier"
  | "warmup"
  | "briefs"
  | "register"
  | "mirrors"
  | "tmux"
  | "daemon";

export type StartEvent =
  | { type: "stage"; stage: StartStage; status: "start" | "done"; detail?: string }
  | { type: "warning"; message: string }
  | { type: "info"; message: string };

export type StartReporter = (event: StartEvent) => void;

export type StartOptions = {
  configPath: string;
  attach?: boolean;
  terminal?: TerminalAttachMode;
  cliPath: string;
  reporter?: StartReporter;
  runWarmup?: (state: RunState) => Promise<void>;
  attachWhenDone?: boolean;
};

// Reproduces the historical console output: warnings and info lines print, stage
// progress events stay silent.
export function consoleStartReporter(event: StartEvent): void {
  if (event.type === "warning") {
    console.warn(event.message);
  } else if (event.type === "info") {
    console.log(event.message);
  }
}

function makeRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function sanitizeBranchPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-");
}

function assertSupportedPlatform(): void {
  if (process.platform === "win32") {
    throw new Error("Agent Arena v1 supports macOS and Linux. Windows support is deferred.");
  }
}

function assertBinary(binary: string, label: string): void {
  if (!commandExists(binary)) {
    throw new Error(`Missing required ${label}: ${binary}`);
  }
}

function buildClaimCommand(cliPath: string, runId: string, agentId: string): string {
  return `${shellQuote(process.execPath)} ${shellQuote(cliPath)} claim --run ${shellQuote(runId)} --agent ${shellQuote(agentId)}`;
}

function buildAgentCliCommand(cliPath: string, runId: string, statePath: string, agentId: string, command: string): string {
  return `${shellQuote(process.execPath)} ${shellQuote(cliPath)} ${command} --run ${shellQuote(runId)} --state ${shellQuote(statePath)} --agent ${shellQuote(agentId)}`;
}

export type AgentRuntimeLayout = {
  input: AgentInput;
  workspace: string;
  branch: string;
  claimScript: string;
  chatScript: string;
  proposePatchScript: string;
  applyProposalScript: string;
  goalFile: string;
  briefFile: string;
  rivalsDir: string;
  rivalDirs: Record<string, string>;
  claimCommand: string;
  launch: AgentLaunchResolution;
};

export function buildAgentLayouts(
  agents: AgentInput[],
  workspaceRoot: string,
  runId: string,
  goal: string,
  cliPath: string,
  statePath = "",
  runtime: {
    teamsByAgent?: Map<string, RunTeam>;
    codenames?: Record<string, string>;
  } = {}
): AgentRuntimeLayout[] {
  return agents.map((agent) => {
    const workspace = path.join(workspaceRoot, agent.id);
    const branch = `agent-arena/${sanitizeBranchPart(runId)}/${sanitizeBranchPart(agent.id)}`;
    const arenaDir = path.join(workspace, ".arena");
    const claimScript = path.join(arenaDir, "claim.sh");
    const chatScript = path.join(arenaDir, "chat.sh");
    const proposePatchScript = path.join(arenaDir, "propose-patch.sh");
    const applyProposalScript = path.join(arenaDir, "apply-proposal.sh");
    const goalFile = path.join(arenaDir, "goal.md");
    const briefFile = path.join(arenaDir, "brief.md");
    const rivalsDir = path.join(arenaDir, "rivals");
    const rivalDirs = Object.fromEntries(
      agents
        .filter((candidate) => candidate.id !== agent.id)
        .map((candidate) => [candidate.id, path.join(rivalsDir, candidate.id)])
    );
    const claimCommand = buildClaimCommand(cliPath, runId, agent.id);
    const team = runtime.teamsByAgent?.get(agent.id);
    const chatCommand = statePath ? buildAgentCliCommand(cliPath, runId, statePath, agent.id, "chat send") : "";

    return {
      input: agent,
      workspace,
      branch,
      claimScript,
      chatScript,
      proposePatchScript,
      applyProposalScript,
      goalFile,
      briefFile,
      rivalsDir,
      rivalDirs,
      claimCommand,
      launch: resolveAgentLaunch(agent, {
        goal,
        goalFile,
        claimCommand,
        rivalDir: rivalsDir,
        workspace,
        agentId: agent.id,
        runId,
        teamId: team?.id,
        teamName: team?.name,
        agentCodename: runtime.codenames?.[agent.id] ?? agent.codename,
        captainAgentId: team?.captainAgentId,
        chatCommand
      })
    };
  });
}

function runtimeTeams(teams: TeamInput[]): RunTeam[] {
  return teams.map((team) => ({
    id: team.id,
    name: team.name,
    captainAgentId: team.captainAgentId,
    agentIds: team.agentIds,
    instructions: team.instructions,
    resources: team.resources ?? []
  }));
}

export async function startArena(options: StartOptions): Promise<RunState> {
  const report = options.reporter ?? consoleStartReporter;

  assertSupportedPlatform();
  assertBinary("git", "binary");
  assertBinary("tmux", "binary");

  report({ type: "stage", stage: "preflight", status: "start" });
  const config = await readConfig(options.configPath);
  const baseRepo = path.resolve(path.dirname(path.resolve(options.configPath)), config.baseRepo);
  const repoRoot = resolveGitRoot(baseRepo);
  const baseCommit = resolveGitRef(repoRoot, config.baseRef);
  const preflight = preflightAgents(config.agents, repoRoot, {
    onProgress: (agentId, check) => {
      report({ type: "stage", stage: "preflight", status: "start", detail: `${agentId}: ${check}` });
    }
  });
  for (const issue of preflight.issues.filter((candidate) => candidate.severity === "warning")) {
    report({ type: "warning", message: `Preflight warning: ${issue.agentId}: ${issue.message}` });
  }
  if (!preflight.ok) {
    throw new Error(`Agent preflight failed:\n${formatPreflightIssues(preflight.issues.filter((issue) => issue.severity === "error"))}`);
  }
  report({ type: "stage", stage: "preflight", status: "done" });

  const runId = makeRunId();
  const arenaRoot = path.join(repoRoot, ".agent-arena");
  const runDir = path.join(arenaRoot, "runs", runId);
  const workspaceRoot = path.join(arenaRoot, "workspaces", runId);
  const statePath = path.join(runDir, "state.json");
  const sessionName = `${config.tmux.sessionPrefix}-${runId.slice(-8)}`;
  const savedSecrets = readSecretsEnv(arenaRoot);
  const setupVerifierSource = path.join(arenaRoot, "setup", "verifier.sh");
  let setupVerifierExists = false;
  try {
    await fs.access(setupVerifierSource);
    setupVerifierExists = true;
  } catch {
    setupVerifierExists = false;
  }
  const judging =
    setupVerifierExists && config.judging.mode === "verifier"
      ? {
          mode: "verifier" as const,
          verifyCommand: "./.arena/verifier.sh"
        }
      : config.judging;

  const runTeams = runtimeTeams(config.teams);
  const teamsByAgent = new Map<string, RunTeam>();
  for (const team of runTeams) {
    for (const agentId of team.agentIds) {
      teamsByAgent.set(agentId, team);
    }
  }
  const codenames = assignCodenames(config.agents, runId);
  const layouts = buildAgentLayouts(config.agents, workspaceRoot, runId, config.goal, options.cliPath, statePath, {
    teamsByAgent,
    codenames
  });

  report({ type: "stage", stage: "resources", status: "start" });
  const blockingErrors = [
    ...resourceBlockingErrors(config.resources, "shared resource", { savedSecrets, baseDir: repoRoot }),
    ...runTeams.flatMap((team) =>
      resourceBlockingErrors(team.resources, `${team.id} team resource`, {
        savedSecrets,
        baseDir: repoRoot
      })
    ),
    ...layouts.flatMap((layout) =>
      resourceBlockingErrors(layout.input.resources ?? [], `${layout.input.id} resource`, {
        savedSecrets,
        agentEnv: layout.input.env,
        baseDir: repoRoot
      })
    )
  ];
  if (blockingErrors.length > 0) {
    throw new Error(`Missing required resources:\n${blockingErrors.map((error) => `- ${error}`).join("\n")}`);
  }

  for (const warning of resourceWarnings(config.resources, "shared resource", { savedSecrets, baseDir: repoRoot })) {
    report({ type: "warning", message: warning });
  }
  for (const warning of resourceOrderWarnings(config.resources, "shared resource")) {
    report({ type: "warning", message: warning });
  }

  for (const layout of layouts) {
    if (layout.launch.binary) {
      assertBinary(layout.launch.binary, `agent binary for ${layout.input.id}`);
    }
    for (const warning of resourceWarnings(layout.input.resources ?? [], `${layout.input.id} resource`, {
      savedSecrets,
      agentEnv: layout.input.env,
      baseDir: repoRoot
    })) {
      report({ type: "warning", message: warning });
    }
    for (const warning of resourceOrderWarnings(layout.input.resources ?? [], `${layout.input.id} resource`)) {
      report({ type: "warning", message: warning });
    }
    const team = teamsByAgent.get(layout.input.id);
    if (team) {
      for (const warning of resourceWarnings(team.resources, `${team.id} team resource`, {
        savedSecrets,
        agentEnv: layout.input.env,
        baseDir: repoRoot
      })) {
        report({ type: "warning", message: warning });
      }
      for (const warning of resourceOrderWarnings(team.resources, `${team.id} team resource`)) {
        report({ type: "warning", message: warning });
      }
    }
    for (const warning of layout.launch.warnings) {
      report({ type: "warning", message: warning });
    }
  }
  report({ type: "stage", stage: "resources", status: "done" });

  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });

  const runAgents: RunAgent[] = [];

  report({ type: "stage", stage: "worktrees", status: "start" });
  for (const [index, layout] of layouts.entries()) {
    report({
      type: "stage",
      stage: "worktrees",
      status: "start",
      detail: `${layout.input.id} (${index + 1}/${layouts.length})`
    });
    await createWorktree(repoRoot, layout.workspace, layout.branch, baseCommit);
  }
  report({ type: "stage", stage: "worktrees", status: "done", detail: `${layouts.length} workspaces` });

  report({ type: "stage", stage: "verifier", status: "start" });
  if (setupVerifierExists) {
    for (const layout of layouts) {
      const verifierTarget = path.join(layout.workspace, ".arena", "verifier.sh");
      await fs.mkdir(path.dirname(verifierTarget), { recursive: true });
      await fs.copyFile(setupVerifierSource, verifierTarget);
      await fs.chmod(verifierTarget, 0o755);
    }
  }
  report({
    type: "stage",
    stage: "verifier",
    status: "done",
    detail: setupVerifierExists ? "setup verifier copied into workspaces" : "no setup verifier"
  });

  for (const layout of layouts) {
    const agent = layout.input;
    const team = teamsByAgent.get(agent.id);
    if (!team) {
      throw new Error(`Agent ${agent.id} is not assigned to a team.`);
    }
    runAgents.push({
      id: agent.id,
      name: agent.name ?? agent.id,
      codename: codenames[agent.id] ?? agent.name ?? agent.id,
      teamId: team.id,
      teamName: team.name,
      captainAgentId: team.captainAgentId,
      isCaptain: team.captainAgentId === agent.id,
      preset: agent.preset,
      binary: layout.launch.binary,
      command: layout.launch.command,
      configuredGoalMode: layout.launch.configuredGoalMode,
      launchMode: layout.launch.launchMode,
      launchNote: layout.launch.launchNote,
      goalCapability: layout.launch.goalCapability,
      model: agent.model,
      thinkingLevel: agent.thinkingLevel,
      env: agent.env,
      instructions: agent.instructions,
      teamInstructions: team.instructions,
      teamResources: team.resources,
      resources: agent.resources ?? [],
      workspace: layout.workspace,
      branch: layout.branch,
      goalFile: layout.goalFile,
      briefFile: layout.briefFile,
      claimScript: layout.claimScript,
      claimCommand: layout.claimCommand,
      chatScript: layout.chatScript,
      chatCommand: buildAgentCliCommand(options.cliPath, runId, statePath, agent.id, "chat send"),
      chatInboxCommand: buildAgentCliCommand(options.cliPath, runId, statePath, agent.id, "chat inbox"),
      chatHistoryCommand: buildAgentCliCommand(options.cliPath, runId, statePath, agent.id, "chat history"),
      proposePatchScript: layout.proposePatchScript,
      proposePatchCommand: buildAgentCliCommand(options.cliPath, runId, statePath, agent.id, "proposal create"),
      applyProposalScript: layout.applyProposalScript,
      applyProposalCommand: buildAgentCliCommand(options.cliPath, runId, statePath, agent.id, "proposal apply"),
      rivalsDir: layout.rivalsDir,
      rivalDirs: layout.rivalDirs
    });
  }

  const state: RunState = {
    runId,
    status: "running",
    startedAt: new Date().toISOString(),
    baseRepo: repoRoot,
    baseRef: baseCommit,
    arenaRoot,
    runDir,
    statePath,
    goal: config.goal,
    successCriteria: config.successCriteria,
    resources: config.resources,
    verifyCommand: judging.mode === "verifier" ? judging.verifyCommand : config.verifyCommand,
    judging,
    teams: runTeams,
    peek: config.peek,
    tmux: {
      sessionName,
      attach: options.attach ?? config.tmux.attach
    },
    agents: runAgents,
    claims: []
  };

  if (state.tmux.attach) {
    report({
      type: "stage",
      stage: "warmup",
      status: "start",
      detail: "complete trust/auth prompts in the warmup window, then exit each agent CLI"
    });
    report({ type: "info", message: "Opening agent trust/auth warmup session before the race..." });
    await (options.runWarmup ?? ((warmupState: RunState) => runTrustWarmup(warmupState, options.terminal ?? "auto")))(state);
    report({ type: "stage", stage: "warmup", status: "done" });
  }

  report({ type: "stage", stage: "briefs", status: "start" });
  for (const agent of state.agents) {
    const rivals = state.agents.filter((candidate) => candidate.id !== agent.id);
    await writeAgentBrief(agent, rivals, state);
  }
  report({ type: "stage", stage: "briefs", status: "done", detail: `${state.agents.length} briefs` });

  report({ type: "stage", stage: "register", status: "start" });
  await writeRunState(state);
  await registerRun(runId, statePath);
  report({ type: "stage", stage: "register", status: "done" });

  report({ type: "stage", stage: "mirrors", status: "start" });
  await refreshAllMirrors(state);
  await updateCompetitionArtifacts(state);
  await writeRunState(state);
  report({ type: "stage", stage: "mirrors", status: "done" });

  report({ type: "stage", stage: "tmux", status: "start" });
  const paneIds = launchTmux(state);
  for (const agent of state.agents) {
    agent.paneId = paneIds[agent.id];
  }
  await writeRunState(state);
  report({ type: "stage", stage: "tmux", status: "done", detail: sessionName });

  report({ type: "stage", stage: "daemon", status: "start" });
  const daemonPid = spawnMirrorDaemon(runId, statePath, options.cliPath, path.join(runDir, "mirror-daemon.log"));
  state.mirrorDaemonPid = daemonPid;
  await writeRunState(state);
  report({ type: "stage", stage: "daemon", status: "done", detail: daemonPid ? `pid ${daemonPid}` : undefined });

  report({ type: "info", message: `Started Agent Arena run ${runId}` });
  report({ type: "info", message: `State: ${statePath}` });
  report({ type: "info", message: `tmux session: ${sessionName}` });
  report({ type: "info", message: `Attach later with: tmux attach-session -t ${sessionName}` });

  const shouldAttach = options.attachWhenDone ?? state.tmux.attach;
  if (shouldAttach) {
    const attached = attachTmux(sessionName, options.terminal ?? "auto");
    for (const warning of attached.warnings) {
      report({ type: "warning", message: warning });
    }
  }

  return state;
}
