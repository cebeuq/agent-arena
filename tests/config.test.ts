import { describe, expect, it } from "vitest";
import { parseArenaConfig } from "../src/config.js";
import { resourceWarnings } from "../src/resources.js";

describe("config parsing", () => {
  it("parses old verifier configs and applies defaults", () => {
    const config = parseArenaConfig({
      goal: "Win the race.",
      verifyCommand: "npm test",
      agents: [
        { id: "a", preset: "claude" },
        { id: "b", preset: "codex" }
      ]
    });

    expect(config.baseRepo).toBe(".");
    expect(config.baseRef).toBe("HEAD");
    expect(config.agents.map((agent) => agent.goalMode)).toEqual(["auto", "auto"]);
    expect(config.agents.map((agent) => agent.thinkingLevel)).toEqual(["auto", "auto"]);
    expect(config.agents.map((agent) => agent.resources)).toEqual([[], []]);
    expect(config.judging).toEqual({
      mode: "verifier",
      verifyCommand: "npm test"
    });
    expect(config.peek.refreshIntervalSeconds).toBe(30);
    expect(config.tmux.sessionPrefix).toBe("agent-arena");
    expect(config.teams.map((team) => team.id)).toEqual(["a", "b"]);
    expect(config.teams.map((team) => team.captainAgentId)).toEqual(["a", "b"]);
  });

  it("defaults new configs to manual judging", () => {
    const config = parseArenaConfig({
      goal: "Win the race.",
      agents: [
        { id: "a", preset: "claude" },
        { id: "b", preset: "codex" }
      ]
    });

    expect(config.verifyCommand).toBeUndefined();
    expect(config.judging).toEqual({
      mode: "manual"
    });
  });

  it("allows goal mode overrides", () => {
    const config = parseArenaConfig({
      goal: "Win the race.",
      verifyCommand: "npm test",
      agents: [
        { id: "a", preset: "claude", goalMode: "goal" },
        { id: "b", preset: "codex", goalMode: "prompt" }
      ]
    });

    expect(config.agents.map((agent) => agent.goalMode)).toEqual(["goal", "prompt"]);
  });

  it("allows per-agent model and thinking level overrides", () => {
    const config = parseArenaConfig({
      goal: "Win the race.",
      agents: [
        { id: "a", preset: "claude", model: "sonnet", thinkingLevel: "max" },
        { id: "b", preset: "codex", model: "gpt-5-codex", thinkingLevel: "high" }
      ]
    });

    expect(config.agents[0].model).toBe("sonnet");
    expect(config.agents[0].thinkingLevel).toBe("max");
    expect(config.agents[1].model).toBe("gpt-5-codex");
    expect(config.agents[1].thinkingLevel).toBe("high");
  });

  it("ignores legacy competition and constraints keys from old configs", () => {
    const config = parseArenaConfig({
      goal: "Win the race.",
      competition: {
        mode: "quiet",
        rivalAwareness: "claim-time"
      },
      constraints: ["Old constraint."],
      judging: {
        mode: "manual",
        claimantBehavior: "wait",
        notifyRivals: true
      },
      agents: [
        { id: "a", preset: "claude" },
        { id: "b", preset: "codex" }
      ]
    });

    expect(config).not.toHaveProperty("competition");
    expect(config).not.toHaveProperty("constraints");
    expect(config.judging).toEqual({ mode: "manual" });
  });

  it("rejects invalid goal modes", () => {
    expect(() =>
      parseArenaConfig({
        goal: "Win the race.",
        verifyCommand: "npm test",
        agents: [
          { id: "a", preset: "claude", goalMode: "forever" },
          { id: "b", preset: "codex" }
        ]
      })
    ).toThrow(/goalMode/);
  });

  it("rejects invalid thinking levels", () => {
    expect(() =>
      parseArenaConfig({
        goal: "Win the race.",
        agents: [
          { id: "a", preset: "claude", thinkingLevel: "gigantic" },
          { id: "b", preset: "codex" }
        ]
      })
    ).toThrow(/thinkingLevel/);
  });

  it("rejects fewer than two agents", () => {
    expect(() =>
      parseArenaConfig({
        goal: "Win the race.",
        agents: [{ id: "a", preset: "claude" }]
      })
    ).toThrow(/at least two/);
  });

  it("accepts three built-in agents", () => {
    const config = parseArenaConfig({
      goal: "Win the race.",
      agents: [
        { id: "claude", preset: "claude" },
        { id: "codex", preset: "codex" },
        { id: "cursor", preset: "cursor" }
      ]
    });

    expect(config.agents.map((agent) => agent.id)).toEqual(["claude", "codex", "cursor"]);
  });

  it("parses explicit team configs with repeated presets and team resources", () => {
    const config = parseArenaConfig({
      goal: "Win the race.",
      resources: [
        {
          type: "note",
          name: "Shared note",
          usage: "Use across every team."
        }
      ],
      teams: [
        {
          id: "red",
          name: "Team Red",
          captainAgentId: "red-codex",
          agentIds: ["red-codex", "red-claude"],
          instructions: "Integrate teammate patches quickly.",
          resources: [
            {
              type: "gpu",
              name: "Red GPU",
              host: "red-gpu.local",
              usage: "Run red-team benchmarks."
            }
          ]
        },
        {
          id: "blue",
          name: "Team Blue",
          captainAgentId: "blue-codex",
          agentIds: ["blue-codex"]
        }
      ],
      agents: [
        { id: "red-codex", preset: "codex", codename: "Nova" },
        { id: "red-claude", preset: "claude" },
        { id: "blue-codex", preset: "codex" }
      ]
    });

    expect(config.teams.map((team) => team.id)).toEqual(["red", "blue"]);
    expect(config.teams[0].resources?.[0].name).toBe("Red GPU");
    expect(config.teams[0].instructions).toContain("Integrate");
    expect(config.agents.map((agent) => agent.preset)).toEqual(["codex", "claude", "codex"]);
  });

  it("rejects invalid team definitions", () => {
    const base = {
      goal: "Win the race.",
      agents: [
        { id: "red-codex", preset: "codex" },
        { id: "red-claude", preset: "claude" },
        { id: "blue-codex", preset: "codex" }
      ]
    };

    expect(() =>
      parseArenaConfig({
        ...base,
        teams: [
          {
            id: "red",
            name: "Team Red",
            captainAgentId: "red-codex",
            agentIds: ["red-codex", "red-claude"]
          }
        ]
      })
    ).toThrow(/at least two teams/i);

    expect(() =>
      parseArenaConfig({
        ...base,
        teams: [
          {
            id: "red",
            name: "Team Red",
            captainAgentId: "missing",
            agentIds: ["red-codex", "red-claude"]
          },
          {
            id: "blue",
            name: "Team Blue",
            captainAgentId: "blue-codex",
            agentIds: ["blue-codex"]
          }
        ]
      })
    ).toThrow(/Captain missing must belong/i);

    expect(() =>
      parseArenaConfig({
        ...base,
        teams: [
          {
            id: "red",
            name: "Team Red",
            captainAgentId: "red-codex",
            agentIds: ["red-codex", "red-claude"]
          },
          {
            id: "blue",
            name: "Team Blue",
            captainAgentId: "blue-codex",
            agentIds: ["blue-codex", "red-claude"]
          }
        ]
      })
    ).toThrow(/belongs to both/i);

    expect(() =>
      parseArenaConfig({
        ...base,
        teams: [
          {
            id: "red",
            name: "Team Red",
            captainAgentId: "red-codex",
            agentIds: ["red-codex"]
          },
          {
            id: "blue",
            name: "Team Blue",
            captainAgentId: "blue-codex",
            agentIds: ["blue-codex"]
          }
        ]
      })
    ).toThrow(/must belong to exactly one team/i);
  });

  it("rejects duplicate provided codenames", () => {
    expect(() =>
      parseArenaConfig({
        goal: "Win the race.",
        agents: [
          { id: "a", preset: "claude", codename: "Nova" },
          { id: "b", preset: "codex", codename: "nova" }
        ]
      })
    ).toThrow(/codenames must be unique/i);
  });

  it("parses resources and reports missing env vars as warnings", () => {
    const config = parseArenaConfig({
      goal: "Win the race.",
      resources: [
        {
          type: "env",
          name: "Missing test env",
          envVar: "AGENT_ARENA_MISSING_TEST_ENV"
        },
        {
          type: "gpu",
          name: "GPU host",
          host: "gpu.local",
          usage: "Run remote benchmarks.",
          whenToUse: "Use when local compute is insufficient.",
          cleanup: "Stop jobs after use."
        }
      ],
      agents: [
        { id: "a", preset: "claude" },
        { id: "b", preset: "codex" }
      ]
    });

    expect(config.resources).toHaveLength(2);
    expect(config.resources[1].usage).toBe("Run remote benchmarks.");
    expect(resourceWarnings(config.resources)[0]).toContain("AGENT_ARENA_MISSING_TEST_ENV is missing");
  });

  it("rejects agents without a preset or command", () => {
    expect(() =>
      parseArenaConfig({
        goal: "Win the race.",
        verifyCommand: "npm test",
        agents: [{ id: "a" }, { id: "b", preset: "codex" }]
      })
    ).toThrow(/preset or command/);
  });

  it("rejects duplicate agent ids", () => {
    expect(() =>
      parseArenaConfig({
        goal: "Win the race.",
        verifyCommand: "npm test",
        agents: [
          { id: "same", preset: "claude" },
          { id: "same", preset: "codex" }
        ]
      })
    ).toThrow(/unique/);
  });
});
