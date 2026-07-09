import { describe, expect, it } from "vitest";
import { preflightAgents } from "../src/preflight.js";
import type { AgentInput } from "../src/types.js";

function agent(id: string, preset: AgentInput["preset"], model?: string): AgentInput {
  return {
    id,
    preset,
    goalMode: "auto",
    model
  };
}

describe("agent harness preflight", () => {
  it("runs version and model probes for configured Codex models", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = preflightAgents([agent("codex-a", "codex", "gpt-5")], "/repo", {
      commandExists: () => true,
      runner: (command, args) => {
        calls.push({ command, args });
        if (args[0] === "--version") {
          return { status: 0, stdout: "codex 0.133.0", stderr: "" };
        }
        return { status: 0, stdout: "AGENT_ARENA_PREFLIGHT_OK", stderr: "" };
      }
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(calls.map((call) => [call.command, call.args[0]])).toEqual([
      ["codex", "--version"],
      ["codex", "exec"]
    ]);
    expect(calls[1].args).toContain("gpt-5");
  });

  it("never runs interactive doctor commands (false negatives without a TTY)", () => {
    const calls: string[] = [];
    preflightAgents([agent("claude-a", "claude", "sonnet"), agent("codex-a", "codex", "gpt-5")], "/repo", {
      commandExists: () => true,
      runner: (command, args) => {
        calls.push(`${command} ${args[0]}`);
        if (args[0] === "--version") {
          return { status: 0, stdout: `${command} 2.1.170`, stderr: "" };
        }
        return { status: 0, stdout: "AGENT_ARENA_PREFLIGHT_OK", stderr: "" };
      }
    });

    expect(calls.every((call) => !call.includes("doctor"))).toBe(true);
  });

  it("blocks unsupported Codex model probes with a remediation message", () => {
    const result = preflightAgents([agent("codex-a", "codex", "gpt-5-codex")], "/repo", {
      commandExists: () => true,
      runner: (_command, args) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "codex 0.133.0", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "model not available for this account" };
      }
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({
      agentId: "codex-a",
      severity: "error"
    });
    expect(result.issues[0].message).toContain("Codex model preflight failed for gpt-5-codex");
  });

  it("blocks Claude when its model probe fails", () => {
    const result = preflightAgents([agent("claude-a", "claude", "sonnet")], "/repo", {
      commandExists: () => true,
      runner: (_command, args) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "2.1.170 (Claude Code)", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "not logged in" };
      }
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toContain("Claude model preflight failed for sonnet");
  });

  it("blocks a harness when its version command fails", () => {
    const result = preflightAgents([agent("claude-a", "claude")], "/repo", {
      commandExists: () => true,
      runner: () => ({ status: 1, stdout: "", stderr: "unknown flag" })
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toContain("Could not read Claude Code version");
  });

  it("reports per-agent progress through onProgress", () => {
    const progress: string[] = [];
    preflightAgents([agent("claude-a", "claude", "sonnet")], "/repo", {
      commandExists: () => true,
      onProgress: (agentId, check) => progress.push(`${agentId}: ${check}`),
      runner: (_command, args) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "2.1.170", stderr: "" };
        }
        return { status: 0, stdout: "AGENT_ARENA_PREFLIGHT_OK", stderr: "" };
      }
    });

    expect(progress[0]).toBe("claude-a: claude --version");
    expect(progress[1]).toContain("claude-a: model probe sonnet");
  });

  it("probes Cursor models with a real request and blocks on failure", () => {
    const commands: string[][] = [];
    const result = preflightAgents([agent("cursor-a", "cursor", "grok-4.5-fast-xhigh")], "/repo", {
      commandExists: () => true,
      runner: (_command, args) => {
        commands.push(args);
        if (args[0] === "--version") {
          return { status: 0, stdout: "2026.07.08-0c04a8a", stderr: "" };
        }
        return { status: 0, stdout: "AGENT_ARENA_PREFLIGHT_OK", stderr: "" };
      }
    });

    expect(result.ok).toBe(true);
    expect(commands[1]).toEqual([
      "-p",
      "--trust",
      "--model",
      "grok-4.5-fast-xhigh",
      "Reply with exactly: AGENT_ARENA_PREFLIGHT_OK"
    ]);

    const failed = preflightAgents([agent("cursor-a", "cursor", "bogus-model")], "/repo", {
      commandExists: () => true,
      runner: (_command, args) =>
        args[0] === "--version"
          ? { status: 0, stdout: "2026.07.08-0c04a8a", stderr: "" }
          : { status: 1, stdout: "", stderr: "unknown model" }
    });

    expect(failed.ok).toBe(false);
    expect(failed.issues[0].message).toContain("Cursor model preflight failed");
  });

  it("reports missing harness binaries before any commands run", () => {
    const result = preflightAgents([agent("codex-a", "codex")], "/repo", {
      commandExists: () => false,
      runner: () => {
        throw new Error("runner should not be called");
      }
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toContain("Missing OpenAI Codex CLI binary");
  });
});
