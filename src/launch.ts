import { getPreset } from "./presets.js";
import { commandExists, extractCommandBinary, runChecked, shellQuote } from "./shell.js";
import { renderCommandTemplate } from "./template.js";
import type {
  AgentGoalCapability,
  AgentInput,
  AgentLaunchMode,
  AgentPresetId,
  AgentThinkingLevel,
  GoalMode
} from "./types.js";

export type AgentLaunchContext = {
  goal: string;
  goalFile: string;
  claimCommand: string;
  rivalDir: string;
  workspace: string;
  agentId: string;
  runId: string;
  teamId?: string;
  teamName?: string;
  agentCodename?: string;
  captainAgentId?: string;
  chatCommand?: string;
};

export type AgentLaunchResolution = {
  command: string;
  binary?: string;
  configuredGoalMode: GoalMode;
  launchMode: AgentLaunchMode;
  launchNote?: string;
  goalCapability?: AgentGoalCapability;
  warnings: string[];
};

export type GoalCapabilityProbe = (presetId: AgentPresetId) => AgentGoalCapability;

const goalDirective =
  "/goal Read .arena/goal.md, complete it, and follow the claim and judging instructions exactly.";
const promptDirective = "Read .arena/goal.md and work autonomously until its claim and judging instructions are satisfied.";

function parseVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+/)?.[0];
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));

  for (let index = 0; index < 3; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function templateValues(context: AgentLaunchContext, agent?: AgentInput): Record<string, string> {
  return {
    goal: context.goal,
    goalFile: context.goalFile,
    claimCommand: "./.arena/claim.sh",
    rivalDir: context.rivalDir,
    workspace: context.workspace,
    agentId: context.agentId,
    runId: context.runId,
    teamId: context.teamId ?? "",
    teamName: context.teamName ?? "",
    agentCodename: context.agentCodename ?? "",
    captainAgentId: context.captainAgentId ?? "",
    chatCommand: context.chatCommand ?? "",
    model: agent?.model ?? "",
    thinkingLevel: agent?.thinkingLevel ?? "auto",
    goalDirective,
    promptDirective
  };
}

function normalizeThinkingForPreset(
  presetId: AgentPresetId,
  thinkingLevel: AgentThinkingLevel
): { level?: string; warning?: string } {
  if (thinkingLevel === "auto") {
    return {};
  }

  if (presetId === "claude") {
    if (thinkingLevel === "xhigh") {
      return {
        level: "max",
        warning: "Claude Code uses --effort max; mapped thinkingLevel xhigh to max."
      };
    }
    return { level: thinkingLevel };
  }

  if (presetId === "codex") {
    if (thinkingLevel === "max") {
      return {
        level: "xhigh",
        warning: "Codex reasoning effort uses xhigh; mapped thinkingLevel max to xhigh."
      };
    }
    return { level: thinkingLevel };
  }

  return {
    warning: "Cursor Agent CLI documents --model but not a thinking-level flag; thinkingLevel is recorded in the goal contract only."
  };
}

function presetLaunchOptions(agent: AgentInput, presetId: AgentPresetId): { parts: string[]; warnings: string[] } {
  const parts: string[] = [];
  const warnings: string[] = [];

  if (agent.model) {
    if (presetId === "cursor") {
      parts.push("--model", shellQuote(agent.model));
    } else {
      parts.push("--model", shellQuote(agent.model));
    }
  }

  if (agent.thinkingLevel && agent.thinkingLevel !== "auto") {
    const normalized = normalizeThinkingForPreset(presetId, agent.thinkingLevel);
    if (normalized.warning) {
      warnings.push(`Agent ${agent.id}: ${normalized.warning}`);
    }

    if (normalized.level) {
      if (presetId === "claude") {
        parts.push("--effort", shellQuote(normalized.level));
      } else if (presetId === "codex") {
        parts.push("-c", shellQuote(`reasoning_effort="${normalized.level}"`));
      }
    }
  }

  return { parts, warnings };
}

function applyPresetLaunchOptions(binary: string, command: string, parts: string[]): string {
  if (parts.length === 0) {
    return command;
  }

  const rest = command.startsWith(binary) ? command.slice(binary.length).trim() : command;
  return [binary, ...parts, rest].filter(Boolean).join(" ");
}

export function detectPresetGoalCapability(presetId: AgentPresetId): AgentGoalCapability {
  const preset = getPreset(presetId);

  if (!preset.goalCommand || preset.goalUnsupportedReason) {
    return {
      supported: false,
      reason: preset.goalUnsupportedReason ?? `${preset.displayName} does not support built-in goal mode.`
    };
  }

  if (!commandExists(preset.binary)) {
    return {
      supported: false,
      reason: `Missing binary: ${preset.binary}`,
      minimumVersion: preset.goalMinimumVersion
    };
  }

  let versionOutput = "";
  try {
    versionOutput = runChecked(preset.binary, ["--version"]);
  } catch (error) {
    return {
      supported: false,
      reason: `Could not read ${preset.binary} version: ${(error as Error).message}`,
      minimumVersion: preset.goalMinimumVersion,
      detectionFailed: true
    };
  }

  const detectedVersion = parseVersion(versionOutput);
  if (!detectedVersion) {
    return {
      supported: false,
      reason: `Could not parse ${preset.binary} version from: ${versionOutput}`,
      minimumVersion: preset.goalMinimumVersion,
      detectionFailed: true
    };
  }

  const minimumVersion = preset.goalMinimumVersion;
  if (minimumVersion && compareVersions(detectedVersion, minimumVersion) < 0) {
    return {
      supported: false,
      reason: `${preset.displayName} ${detectedVersion} is older than required ${minimumVersion} for /goal.`,
      detectedVersion,
      minimumVersion
    };
  }

  return {
    supported: true,
    detectedVersion,
    minimumVersion
  };
}

export function resolveAgentLaunch(
  agent: AgentInput,
  context: AgentLaunchContext,
  probeGoalCapability: GoalCapabilityProbe = detectPresetGoalCapability
): AgentLaunchResolution {
  const configuredGoalMode = agent.goalMode;
  const values = templateValues(context, agent);

  if (agent.command) {
    if (configuredGoalMode === "goal") {
      throw new Error(
        `Agent ${agent.id} uses a custom command, so built-in goal mode is unavailable. Put /goal in the command or set goalMode to "prompt" or "auto".`
      );
    }

    return {
      command: renderCommandTemplate(agent.command, values),
      binary: extractCommandBinary(agent.command),
      configuredGoalMode,
      launchMode: "prompt",
      launchNote: "Custom commands use prompt mode unless they include their own /goal invocation.",
      goalCapability: {
        supported: false,
        reason: "Custom command agents do not have built-in goal capability detection."
      },
      warnings: []
    };
  }

  if (!agent.preset) {
    throw new Error(`Agent ${agent.id} must define either preset or command.`);
  }

  const preset = getPreset(agent.preset);
  const goalCapability = probeGoalCapability(agent.preset);
  const options = presetLaunchOptions(agent, agent.preset);

  if (configuredGoalMode === "prompt") {
    return {
      command: applyPresetLaunchOptions(preset.binary, renderCommandTemplate(preset.promptCommand, values), options.parts),
      binary: preset.binary,
      configuredGoalMode,
      launchMode: "prompt",
      goalCapability,
      warnings: options.warnings
    };
  }

  if (goalCapability.supported && preset.goalCommand) {
    return {
      command: applyPresetLaunchOptions(preset.binary, renderCommandTemplate(preset.goalCommand, values), options.parts),
      binary: preset.binary,
      configuredGoalMode,
      launchMode: "goal",
      goalCapability,
      warnings: options.warnings
    };
  }

  if (configuredGoalMode === "goal") {
    throw new Error(
      `Agent ${agent.id} requested goalMode "goal", but ${goalCapability.reason ?? "goal mode is unavailable."}`
    );
  }

  const launchNote = goalCapability.detectionFailed
    ? `${goalCapability.reason ?? "Version detection failed."} Falling back to prompt mode; set goalMode: "goal" to force /goal if you know this CLI supports it.`
    : goalCapability.reason ?? "Goal mode is unavailable; using prompt mode.";
  return {
    command: applyPresetLaunchOptions(preset.binary, renderCommandTemplate(preset.promptCommand, values), options.parts),
    binary: preset.binary,
    configuredGoalMode,
    launchMode: "prompt",
    launchNote,
    goalCapability,
    warnings: [`Agent ${agent.id}: ${launchNote}`, ...options.warnings]
  };
}
