import type { AgentInput, AgentPreset, AgentPresetId } from "./types.js";

export const agentPresets: Record<AgentPresetId, AgentPreset> = {
  claude: {
    id: "claude",
    displayName: "Claude Code",
    binary: "claude",
    promptCommand: "claude {promptDirective}",
    goalCommand: "claude {goalDirective}",
    goalMinimumVersion: "2.1.139",
    installHint: "Install Claude Code from Anthropic, then authenticate with the claude CLI.",
    authHint: "Run `claude` once in a normal terminal and complete authentication.",
    docsUrl: "https://code.claude.com/docs"
  },
  codex: {
    id: "codex",
    displayName: "OpenAI Codex CLI",
    binary: "codex",
    promptCommand: "codex {promptDirective}",
    goalCommand: "codex -c features.goals=true {goalDirective}",
    goalMinimumVersion: "0.133.0",
    installHint: "Install with `npm install -g @openai/codex` or your preferred Codex installer.",
    authHint: "Run `codex` once in a normal terminal and complete authentication.",
    docsUrl: "https://github.com/openai/codex"
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor Agent CLI",
    binary: "cursor-agent",
    // Interactive (not -p print mode) so the pane stays open for chat nudges
    // and pressure notices; --force so shell commands run without approval
    // prompts stalling the race. No --trust: it is headless-only and errors
    // in interactive mode; the workspace trust dialog is what the trust
    // warmup phase is for, and trust persists per directory once accepted.
    promptCommand: "cursor-agent --force {promptDirective}",
    goalUnsupportedReason: "Cursor Agent CLI does not document a /goal command; using prompt mode.",
    installHint: "Install Cursor Agent CLI from Cursor, then authenticate it locally.",
    authHint: "Run `cursor-agent` once in a normal terminal and complete authentication.",
    docsUrl: "https://docs.cursor.com/en/cli/overview"
  }
};

export function getPreset(id: AgentPresetId): AgentPreset {
  return agentPresets[id];
}

export function resolveAgentCommand(agent: AgentInput): string {
  if (agent.command) {
    return agent.command;
  }

  if (!agent.preset) {
    throw new Error(`Agent ${agent.id} must define either preset or command.`);
  }

  return getPreset(agent.preset).promptCommand;
}

export function resolveAgentBinary(agent: AgentInput): string | undefined {
  if (agent.preset) {
    return getPreset(agent.preset).binary;
  }

  return undefined;
}
