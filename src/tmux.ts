import { spawnSync } from "node:child_process";
import { envFromResources, readSecretsEnv } from "./resources.js";
import { shellQuote } from "./shell.js";
import { attachTmuxSession, tmuxAttachCommand, type AttachResult, type TerminalAttachMode } from "./terminal.js";
import type { RunAgent, RunState, RunTeam } from "./types.js";

export type TmuxRunner = (args: string[]) => string;

function runTmux(args: string[]): string {
  const result = spawnSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.status !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed:\n${result.stderr}`);
  }

  return result.stdout.trim();
}

function commandWithArenaEnv(state: RunState, agent: RunAgent): string {
  const savedSecrets = readSecretsEnv(state.arenaRoot);
  const env = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...savedSecrets,
    ...envFromResources(state.resources, { savedSecrets }),
    ...envFromResources(agent.teamResources ?? [], { savedSecrets, agentEnv: agent.env }),
    ...envFromResources(agent.resources, { savedSecrets, agentEnv: agent.env }),
    ...agent.env,
    ARENA_AGENT_ID: agent.id,
    ARENA_AGENT_CODENAME: agent.codename ?? agent.name ?? agent.id,
    ARENA_TEAM_ID: agent.teamId ?? agent.id,
    ARENA_TEAM_NAME: agent.teamName ?? agent.name ?? agent.id,
    ARENA_IS_TEAM_CAPTAIN: agent.isCaptain === false ? "0" : "1",
    ARENA_CAPTAIN_AGENT_ID: agent.captainAgentId ?? agent.id,
    ARENA_RUN_ID: state.runId,
    ARENA_GOAL_FILE: agent.goalFile,
    ARENA_RIVALS_DIR: agent.rivalsDir,
    ARENA_RIVAL_DIR: agent.rivalsDir,
    ARENA_CLAIM_COMMAND: agent.claimCommand,
    ARENA_CHAT_COMMAND: agent.chatCommand ?? "",
    ARENA_TEAM_CHAT_FILE: `${agent.workspace}/.arena/chat/team.md`,
    ARENA_PUBLIC_CHAT_FILE: `${agent.workspace}/.arena/chat/public.md`,
    ARENA_INBOX_FILE: `${agent.workspace}/.arena/chat/inbox.md`
  };

  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");

  return `env ${envPrefix} ${agent.command}`;
}

function cliPath(): string {
  return process.env.AGENT_ARENA_CLI_PATH ?? process.argv[1];
}

function internalPaneCommand(state: RunState, command: string, args: Record<string, string>): string {
  const pairs = Object.entries({
    run: state.runId,
    state: state.statePath,
    ...args
  });
  return `${shellQuote(process.execPath)} ${shellQuote(cliPath())} ${command} ${pairs
    .flatMap(([key, value]) => [`--${key}`, shellQuote(value)])
    .join(" ")}`;
}

function runTeams(state: RunState): RunTeam[] {
  if (state.teams && state.teams.length > 0) {
    return state.teams;
  }

  return state.agents.map((agent) => ({
    id: agent.teamId ?? agent.id,
    name: agent.teamName ?? agent.name,
    captainAgentId: agent.captainAgentId ?? agent.id,
    agentIds: [agent.id],
    resources: []
  }));
}

function windowTarget(state: RunState, team: RunTeam): string {
  return `${state.tmux.sessionName}:${team.id}`;
}

function setPaneTitle(tmux: TmuxRunner, paneId: string, title: string): void {
  tmux(["select-pane", "-t", paneId, "-T", title]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmuxSessionExists(sessionName: string): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], {
    stdio: "ignore"
  });
  return result.status === 0;
}

// Returns true when a session existed and was killed.
export function killTmuxSession(sessionName: string): boolean {
  if (!tmuxSessionExists(sessionName)) {
    return false;
  }
  const result = spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
  return result.status === 0;
}

// Kill the per-agent grouped view sessions created by openAgentPaneExternal.
export function killTmuxViewSessions(sessionName: string): number {
  const result = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
  if (result.status !== 0) {
    return 0;
  }
  const prefix = `${sessionName}-view-`;
  let killed = 0;
  for (const name of result.stdout.split("\n")) {
    if (name.startsWith(prefix) && killTmuxSession(name)) {
      killed += 1;
    }
  }
  return killed;
}

export type OpenAgentPaneResult = AttachResult & { error?: string };

// Open one agent's pane in an external terminal. Uses a grouped tmux session
// (shared windows, independent current window) so several agents can be viewed
// side by side without fighting over the main session's active window.
export function openAgentPaneExternal(state: RunState, agentId: string): OpenAgentPaneResult {
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  const failure = (error: string): OpenAgentPaneResult => ({
    attached: false,
    launchedExternal: false,
    command: tmuxAttachCommand(state.tmux.sessionName),
    warnings: [],
    error
  });
  if (!agent) {
    return failure(`Unknown agent ${agentId}.`);
  }
  if (!tmuxSessionExists(state.tmux.sessionName)) {
    return failure("The tmux session for this run is gone.");
  }

  const team = runTeams(state).find((candidate) => candidate.id === agent.teamId || candidate.agentIds.includes(agent.id));
  const windowName = team?.id ?? agent.teamId ?? agent.id;
  const viewSession = `${state.tmux.sessionName}-view-${agent.id}`;
  try {
    if (!tmuxSessionExists(viewSession)) {
      runTmux(["new-session", "-d", "-t", state.tmux.sessionName, "-s", viewSession]);
    }
    runTmux(["select-window", "-t", `${viewSession}:${windowName}`]);
    if (agent.paneId) {
      const panes = runTmux(["list-panes", "-t", `${viewSession}:${windowName}`, "-F", "#{pane_id}"]).split("\n");
      if (!panes.includes(agent.paneId)) {
        return failure(`${agent.codename ?? agent.id}'s pane is gone (its process exited).`);
      }
      runTmux(["select-pane", "-t", agent.paneId]);
    }
  } catch (error) {
    return failure((error as Error).message);
  }

  return attachTmuxSession(viewSession, "external");
}

async function waitForTmuxSessionExit(sessionName: string): Promise<void> {
  const deadline = Date.now() + 1000 * 60 * 60;
  while (Date.now() < deadline && tmuxSessionExists(sessionName)) {
    await sleep(1000);
  }
}

function trustWarmupCommand(agent: RunAgent): string {
  const binary = agent.binary ?? agent.preset;
  if (!binary) {
    return "printf 'Custom command agent: no native trust warmup needed.\\n'";
  }
  return [
    "printf",
    shellQuote(
      [
        `Agent Arena trust warmup for ${agent.codename} (${agent.id}).`,
        "If the CLI asks whether you trust this workspace or needs auth, complete that prompt.",
        "Then exit the CLI. The real race has not started yet.",
        ""
      ].join("\n")
    ),
    ";",
    "exec",
    shellQuote(binary)
  ].join(" ");
}

export async function runTrustWarmup(
  state: RunState,
  mode: TerminalAttachMode = "auto",
  tmux: TmuxRunner = runTmux,
  agentIds?: string[]
): Promise<void> {
  const agents = state.agents.filter(
    (agent) => agent.binary && agent.preset && (!agentIds || agentIds.includes(agent.id))
  );
  if (agents.length === 0) {
    return;
  }

  const sessionName = `${state.tmux.sessionName}-trust`;
  // A previous attempt (e.g. an external attach that failed over SSH) may have
  // left the session behind; creating over it would fail with
  // "duplicate session". Recreate from scratch.
  try {
    tmux(["kill-session", "-t", sessionName]);
  } catch {
    // No leftover session.
  }
  let first = true;
  let anchor = "";
  for (const agent of agents) {
    const args = first
      ? [
          "new-session",
          "-d",
          "-P",
          "-F",
          "#{pane_id}",
          "-s",
          sessionName,
          "-n",
          "trust",
          "-c",
          agent.workspace,
          trustWarmupCommand(agent)
        ]
      : ["split-window", "-P", "-F", "#{pane_id}", "-t", anchor, "-c", agent.workspace, trustWarmupCommand(agent)];
    const paneId = tmux(args);
    anchor = anchor || paneId;
    setPaneTitle(tmux, paneId, `Trust ${agent.codename} (${agent.id})`);
    first = false;
  }
  tmux(["select-layout", "-t", sessionName, "tiled"]);

  const attached = attachTmux(sessionName, mode);
  if (!attached.attached && !attached.launchedExternal && !attached.openedInTmux) {
    // Don't leave the freshly created session behind: the caller may retry
    // with a different attach mode.
    try {
      tmux(["kill-session", "-t", sessionName]);
    } catch {
      // Best effort.
    }
    throw new Error(`Could not open trust warmup session.\n${attached.warnings.join("\n")}`);
  }
  if (attached.launchedExternal || attached.openedInTmux) {
    await waitForTmuxSessionExit(sessionName);
  }
}

export function launchTmux(state: RunState, tmux: TmuxRunner = runTmux): Record<string, string> {
  const paneIds: Record<string, string> = {};
  const teams = runTeams(state);
  let createdFirstWindow = false;

  for (const team of teams) {
    const agents = state.agents.filter((agent) => agent.teamId === team.id || team.agentIds.includes(agent.id));
    if (agents.length === 0) {
      continue;
    }

    const sidebarCommand = internalPaneCommand(state, "tui team-sidebar", { team: team.id });
    const sidebarPane = createdFirstWindow
      ? tmux([
          "new-window",
          "-P",
          "-F",
          "#{pane_id}",
          "-t",
          state.tmux.sessionName,
          "-n",
          team.id,
          "-c",
          state.baseRepo,
          sidebarCommand
        ])
      : tmux([
          "new-session",
          "-d",
          "-P",
          "-F",
          "#{pane_id}",
          "-s",
          state.tmux.sessionName,
          "-n",
          team.id,
          "-c",
          state.baseRepo,
          sidebarCommand
        ]);
    createdFirstWindow = true;

    tmux(["set-window-option", "-t", windowTarget(state, team), "pane-border-status", "top"]);
    tmux(["set-window-option", "-t", windowTarget(state, team), "pane-border-format", "#{pane_title}"]);
    setPaneTitle(tmux, sidebarPane, `Arena ${team.name}`);

    const [firstAgent, ...otherAgents] = agents;
    paneIds[firstAgent.id] = tmux([
      "split-window",
      "-h",
      "-p",
      "82",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      sidebarPane,
      "-c",
      firstAgent.workspace,
      commandWithArenaEnv(state, firstAgent)
    ]);
    setPaneTitle(
      tmux,
      paneIds[firstAgent.id],
      `${firstAgent.codename ?? firstAgent.name} (${firstAgent.id})${firstAgent.isCaptain ? " CAPTAIN" : ""}`
    );

    let agentAnchorPane = paneIds[firstAgent.id];
    for (const agent of otherAgents) {
      paneIds[agent.id] = tmux([
        "split-window",
        "-v",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        agentAnchorPane,
        "-c",
        agent.workspace,
        commandWithArenaEnv(state, agent)
      ]);
      setPaneTitle(tmux, paneIds[agent.id], `${agent.codename ?? agent.name} (${agent.id})${agent.isCaptain ? " CAPTAIN" : ""}`);
      agentAnchorPane = paneIds[agent.id];
    }

    tmux(["select-pane", "-t", paneIds[firstAgent.id]]);
  }

  if (teams[0]) {
    tmux(["select-window", "-t", windowTarget(state, teams[0])]);
  }

  return paneIds;
}

export function attachTmux(sessionName: string, mode: TerminalAttachMode = "auto"): AttachResult {
  return attachTmuxSession(sessionName, mode);
}

export function notifyTmux(sessionName: string, message: string): void {
  const result = spawnSync("tmux", ["display-message", "-t", sessionName, message], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    // tmux notification is best-effort; the run result is already persisted.
  }
}

export function sendTmuxPaneText(paneId: string | undefined, message: string): void {
  if (!paneId) {
    return;
  }

  const bufferName = `agent-arena-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const buffer = spawnSync("tmux", ["set-buffer", "-b", bufferName, message], {
    encoding: "utf8"
  });

  if (buffer.status === 0) {
    const pasted = spawnSync("tmux", ["paste-buffer", "-d", "-b", bufferName, "-t", paneId], {
      encoding: "utf8"
    });
    if (pasted.status !== 0) {
      return;
    }
  } else {
    const literal = spawnSync("tmux", ["send-keys", "-t", paneId, "-l", message], {
      encoding: "utf8"
    });
    if (literal.status !== 0) {
      return;
    }
  }

  const enter = spawnSync("tmux", ["send-keys", "-t", paneId, "Enter"], {
    encoding: "utf8"
  });
  if (enter.status !== 0) {
    return;
  }
}

export function sendTmuxPaneCtrlC(paneId: string | undefined): void {
  if (!paneId) {
    return;
  }

  spawnSync("tmux", ["send-keys", "-t", paneId, "C-c"], {
    stdio: "ignore"
  });
}
