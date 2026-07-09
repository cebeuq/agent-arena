import { describe, expect, it } from "vitest";
import { resolveAgentLaunch, type GoalCapabilityProbe } from "../src/launch.js";
import type { AgentInput, AgentPresetId } from "../src/types.js";

const context = {
  goal: "Win the race.",
  goalFile: "/tmp/workspace/.arena/goal.md",
  claimCommand: "node cli.js claim --run run-1 --agent codex",
  rivalDir: "/tmp/workspace/.arena/rival/other",
  workspace: "/tmp/workspace",
  agentId: "codex",
  runId: "run-1"
};

function agent(input: Partial<AgentInput> & Pick<AgentInput, "id">): AgentInput {
  return {
    goalMode: "auto",
    resources: [],
    ...input
  };
}

const capabilities: Record<AgentPresetId, ReturnType<GoalCapabilityProbe>> = {
  claude: {
    supported: false,
    reason: "Claude Code 2.1.98 is older than required 2.1.139 for /goal.",
    detectedVersion: "2.1.98",
    minimumVersion: "2.1.139"
  },
  codex: {
    supported: true,
    detectedVersion: "0.133.0",
    minimumVersion: "0.133.0"
  },
  cursor: {
    supported: false,
    reason: "Cursor Agent CLI does not document a /goal command; using prompt mode."
  }
};

const probe: GoalCapabilityProbe = (preset) => capabilities[preset];

describe("agent launch resolution", () => {
  it("uses goal mode for goal-capable Codex in auto mode", () => {
    const launch = resolveAgentLaunch(agent({ id: "codex", preset: "codex" }), context, probe);

    expect(launch.launchMode).toBe("goal");
    expect(launch.command).toBe(
      "codex -c features.goals=true '/goal Read .arena/goal.md, complete it, and follow the claim and judging instructions exactly.'"
    );
    expect(launch.warnings).toEqual([]);
  });

  it("passes Codex model and reasoning effort flags before the goal directive", () => {
    const launch = resolveAgentLaunch(
      agent({ id: "codex", preset: "codex", model: "gpt-5-codex", thinkingLevel: "high" }),
      context,
      probe
    );

    expect(launch.launchMode).toBe("goal");
    expect(launch.command).toBe(
      "codex --model gpt-5-codex -c 'reasoning_effort=\"high\"' -c features.goals=true '/goal Read .arena/goal.md, complete it, and follow the claim and judging instructions exactly.'"
    );
    expect(launch.warnings).toEqual([]);
  });

  it("keeps long goal text in the goal file instead of the launch command", () => {
    const longGoal = "Improve the project. ".repeat(400);
    const launch = resolveAgentLaunch(
      agent({ id: "codex", preset: "codex" }),
      {
        ...context,
        goal: longGoal
      },
      probe
    );

    expect(launch.command).toContain("/goal Read .arena/goal.md");
    expect(launch.command).not.toContain(longGoal);
  });

  it("falls back to prompt mode with an explicit note when version detection fails", () => {
    const launch = resolveAgentLaunch(agent({ id: "claude", preset: "claude" }), context, () => ({
      supported: false,
      reason: "Could not parse claude version from: dev build",
      detectionFailed: true
    }));

    expect(launch.launchMode).toBe("prompt");
    expect(launch.launchNote).toContain("Falling back to prompt mode");
    expect(launch.launchNote).toContain('goalMode: "goal"');
    expect(launch.warnings[0]).toContain("Could not parse claude version");
  });

  it("falls back to prompt mode for old Claude in auto mode", () => {
    const launch = resolveAgentLaunch(agent({ id: "claude", preset: "claude" }), context, probe);

    expect(launch.launchMode).toBe("prompt");
    expect(launch.command).toBe(
      "claude 'Read .arena/goal.md and work autonomously until its claim and judging instructions are satisfied.'"
    );
    expect(launch.warnings[0]).toMatch(/older than required 2\.1\.139/);
  });

  it("uses goal mode for Claude when capability probe supports it", () => {
    const launch = resolveAgentLaunch(agent({ id: "claude", preset: "claude" }), context, () => ({
      supported: true,
      detectedVersion: "2.1.139",
      minimumVersion: "2.1.139"
    }));

    expect(launch.launchMode).toBe("goal");
    expect(launch.command).toBe(
      "claude '/goal Read .arena/goal.md, complete it, and follow the claim and judging instructions exactly.'"
    );
  });

  it("passes Claude model and effort flags before the goal directive", () => {
    const launch = resolveAgentLaunch(
      agent({ id: "claude", preset: "claude", model: "sonnet", thinkingLevel: "max" }),
      context,
      () => ({
        supported: true,
        detectedVersion: "2.1.139",
        minimumVersion: "2.1.139"
      })
    );

    expect(launch.launchMode).toBe("goal");
    expect(launch.command).toBe(
      "claude --model sonnet --effort max '/goal Read .arena/goal.md, complete it, and follow the claim and judging instructions exactly.'"
    );
  });

  it("maps incompatible effort aliases for preset CLIs", () => {
    const codexLaunch = resolveAgentLaunch(
      agent({ id: "codex", preset: "codex", thinkingLevel: "max" }),
      context,
      probe
    );
    expect(codexLaunch.command).toContain("-c 'reasoning_effort=\"xhigh\"'");
    expect(codexLaunch.warnings[0]).toMatch(/mapped thinkingLevel max to xhigh/);

    const claudeLaunch = resolveAgentLaunch(
      agent({ id: "claude", preset: "claude", thinkingLevel: "xhigh" }),
      context,
      () => ({
        supported: true,
        detectedVersion: "2.1.139",
        minimumVersion: "2.1.139"
      })
    );
    expect(claudeLaunch.command).toContain("--effort max");
    expect(claudeLaunch.warnings[0]).toMatch(/mapped thinkingLevel xhigh to max/);
  });

  it("passes Cursor model but records thinking as a warning-only setting", () => {
    const launch = resolveAgentLaunch(
      agent({ id: "cursor", preset: "cursor", goalMode: "prompt", model: "grok-4.5-fast-xhigh", thinkingLevel: "high" }),
      context,
      probe
    );

    expect(launch.launchMode).toBe("prompt");
    expect(launch.command).toBe(
      "cursor-agent --model grok-4.5-fast-xhigh --force 'Read .arena/goal.md and work autonomously until its claim and judging instructions are satisfied.'"
    );
    expect(launch.warnings[0]).toMatch(/thinking-level flag/);
  });

  it("fails when goal mode is required but unavailable", () => {
    expect(() =>
      resolveAgentLaunch(agent({ id: "cursor", preset: "cursor", goalMode: "goal" }), context, probe)
    ).toThrow(/requested goalMode "goal"/);

    expect(() =>
      resolveAgentLaunch(agent({ id: "claude", preset: "claude", goalMode: "goal" }), context, probe)
    ).toThrow(/older than required/);
  });

  it("keeps custom commands in prompt mode unless they include their own goal behavior", () => {
    const launch = resolveAgentLaunch(
      agent({ id: "custom", command: "my-agent --prompt {goal} --cwd {workspace}" }),
      context,
      probe
    );

    expect(launch.launchMode).toBe("prompt");
    expect(launch.command).toBe("my-agent --prompt 'Win the race.' --cwd /tmp/workspace");
  });

  it("renders team-aware custom command placeholders", () => {
    const launch = resolveAgentLaunch(
      agent({
        id: "red-codex",
        command:
          "my-agent --team {teamId} --name {teamName} --codename {agentCodename} --captain {captainAgentId} --chat {chatCommand}"
      }),
      {
        ...context,
        agentId: "red-codex",
        teamId: "red",
        teamName: "Team Red",
        agentCodename: "Nova",
        captainAgentId: "red-captain",
        chatCommand: "node cli.js chat send --run run-1 --agent red-codex"
      },
      probe
    );

    expect(launch.command).toBe(
      "my-agent --team red --name 'Team Red' --codename Nova --captain red-captain --chat 'node cli.js chat send --run run-1 --agent red-codex'"
    );
  });

  it("fails custom commands that request built-in goal mode", () => {
    expect(() =>
      resolveAgentLaunch(
        agent({ id: "custom", command: "my-agent {goalFile}", goalMode: "goal" }),
        context,
        probe
      )
    ).toThrow(/custom command/);
  });
});
