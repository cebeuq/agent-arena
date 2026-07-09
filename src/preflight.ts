import { spawnSync } from "node:child_process";
import { getPreset } from "./presets.js";
import { commandExists, shellQuote } from "./shell.js";
import type { AgentInput } from "./types.js";

export type PreflightIssue = {
  agentId: string;
  severity: "error" | "warning";
  message: string;
};

export type PreflightResult = {
  ok: boolean;
  issues: PreflightIssue[];
};

export type PreflightRunner = (command: string, args: string[], cwd?: string) => { status: number | null; stdout: string; stderr: string };

export type PreflightOptions = {
  runner?: PreflightRunner;
  commandExists?: (binary: string) => boolean;
  onProgress?: (agentId: string, check: string) => void;
};

function defaultRunner(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 45_000
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function output(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function runVersionPreflight(
  agent: AgentInput,
  binary: string,
  displayName: string,
  cwd: string,
  runner: PreflightRunner,
  issues: PreflightIssue[]
): boolean {
  const version = runner(binary, ["--version"], cwd);
  if (version.status === 0) {
    return true;
  }

  issues.push({
    agentId: agent.id,
    severity: "error",
    message: `Could not read ${displayName} version with \`${binary} --version\`. ${output(version)}`
  });
  return false;
}

function isConfiguredModel(agent: AgentInput): boolean {
  return Boolean(agent.model?.trim());
}

function checkBinary(agent: AgentInput, issues: PreflightIssue[], binaryExists: (binary: string) => boolean): boolean {
  if (!agent.preset) {
    return true;
  }
  const preset = getPreset(agent.preset);
  if (binaryExists(preset.binary)) {
    return true;
  }
  issues.push({
    agentId: agent.id,
    severity: "error",
    message: `Missing ${preset.displayName} binary: ${preset.binary}. ${preset.installHint}`
  });
  return false;
}

// NOTE: deliberately no `doctor` gating here. `claude doctor` and friends are
// interactive diagnostics: spawned without a TTY they run slow update/keychain
// checks and can fail even when the CLI works (false negatives). The version
// check proves the binary runs; the model probe proves auth + model access.
function runCodexPreflight(
  agent: AgentInput,
  cwd: string,
  runner: PreflightRunner,
  issues: PreflightIssue[],
  onProgress: (agentId: string, check: string) => void
): void {
  const preset = getPreset("codex");
  onProgress(agent.id, "codex --version");
  if (!runVersionPreflight(agent, preset.binary, preset.displayName, cwd, runner, issues)) {
    return;
  }

  if (!isConfiguredModel(agent)) {
    return;
  }

  onProgress(agent.id, `model probe ${agent.model} (runs a real request, can take a minute)`);
  const probe = runner(
    "codex",
    [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--model",
      agent.model!,
      "Reply with exactly: AGENT_ARENA_PREFLIGHT_OK"
    ],
    cwd
  );
  if (probe.status !== 0 || !output(probe).includes("AGENT_ARENA_PREFLIGHT_OK")) {
    issues.push({
      agentId: agent.id,
      severity: "error",
      message: `Codex model preflight failed for ${agent.model}. Choose CLI default or a supported model. ${output(probe)}`
    });
  }
}

function runClaudePreflight(
  agent: AgentInput,
  cwd: string,
  runner: PreflightRunner,
  issues: PreflightIssue[],
  onProgress: (agentId: string, check: string) => void
): void {
  const preset = getPreset("claude");
  onProgress(agent.id, "claude --version");
  if (!runVersionPreflight(agent, preset.binary, preset.displayName, cwd, runner, issues)) {
    return;
  }

  if (!isConfiguredModel(agent)) {
    return;
  }

  onProgress(agent.id, `model probe ${agent.model} (runs a real request, can take a minute)`);
  const probe = runner(
    "claude",
    ["-p", "--model", agent.model!, "Reply with exactly: AGENT_ARENA_PREFLIGHT_OK"],
    cwd
  );
  if (probe.status !== 0 || !output(probe).includes("AGENT_ARENA_PREFLIGHT_OK")) {
    issues.push({
      agentId: agent.id,
      severity: "error",
      message: `Claude model preflight failed for ${agent.model}. Choose CLI default or a supported model. ${output(probe)}`
    });
  }
}

function runCursorPreflight(
  agent: AgentInput,
  cwd: string,
  runner: PreflightRunner,
  issues: PreflightIssue[],
  onProgress: (agentId: string, check: string) => void
): void {
  const preset = getPreset("cursor");
  onProgress(agent.id, "cursor-agent --version");
  if (!runVersionPreflight(agent, preset.binary, preset.displayName, cwd, runner, issues)) {
    return;
  }

  if (!isConfiguredModel(agent)) {
    return;
  }

  onProgress(agent.id, `model probe ${agent.model} (runs a real request, can take a minute)`);
  // --trust: headless -p mode hard-fails with "Workspace Trust Required" in
  // any directory the user has not already trusted interactively.
  const probe = runner(
    "cursor-agent",
    ["-p", "--trust", "--model", agent.model!, "Reply with exactly: AGENT_ARENA_PREFLIGHT_OK"],
    cwd
  );
  if (probe.status !== 0 || !output(probe).includes("AGENT_ARENA_PREFLIGHT_OK")) {
    issues.push({
      agentId: agent.id,
      severity: "error",
      message: `Cursor model preflight failed for ${agent.model}. Check \`cursor-agent --list-models\` or use CLI default. ${output(probe)}`
    });
  }
}

export function preflightAgents(
  agents: AgentInput[],
  cwd: string,
  options: PreflightRunner | PreflightOptions = defaultRunner
): PreflightResult {
  const issues: PreflightIssue[] = [];
  const runner = typeof options === "function" ? options : options.runner ?? defaultRunner;
  const binaryExists = typeof options === "function" ? commandExists : options.commandExists ?? commandExists;
  const onProgress = typeof options === "function" ? () => {} : options.onProgress ?? (() => {});

  for (const agent of agents) {
    if (!checkBinary(agent, issues, binaryExists) || !agent.preset) {
      continue;
    }

    if (agent.preset === "codex") {
      runCodexPreflight(agent, cwd, runner, issues, onProgress);
    } else if (agent.preset === "claude") {
      runClaudePreflight(agent, cwd, runner, issues, onProgress);
    } else if (agent.preset === "cursor") {
      runCursorPreflight(agent, cwd, runner, issues, onProgress);
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issues
  };
}

export function formatPreflightIssues(issues: PreflightIssue[]): string {
  return issues.map((issue) => `- ${issue.agentId}: ${issue.message}`).join("\n");
}

export function trustWarmupInstructions(agents: AgentInput[]): string[] {
  return agents.flatMap((agent) => {
    if (!agent.preset || agent.command) {
      return [];
    }
    const preset = getPreset(agent.preset);
    return [`${agent.id}: run ${shellQuote(preset.binary)} once in this workspace if it asks for trust/auth before launch.`];
  });
}
