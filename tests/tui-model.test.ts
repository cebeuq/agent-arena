import { describe, expect, it } from "vitest";
import {
  addAgentDraft,
  addTeamDraft,
  configFromDraft,
  draftFromConfig,
  draftWarnings,
  emptyDraft,
  removeAgentDraft,
  removeTeamDraft,
  reviewJson,
  reviewText,
  setTeamCaptainDraft,
  teamAccentColor
} from "../src/tui-model.js";

describe("TUI model", () => {
  it("builds a manual judging config with team-aware agents", () => {
    const draft = emptyDraft();
    draft.goal = "Optimize search latency.";
    draft.successCriteria = ["p95 latency is under 300ms."];
    draft.agents.push({
      id: "red-claude",
      preset: "claude",
      teamId: "red",
      goalMode: "auto",
      thinkingLevel: "max",
      resources: []
    });
    const codex = draft.agents.find((agent) => agent.id === "red-codex");
    expect(codex).toBeTruthy();
    codex!.instructions = "Use goal mode aggressively.";
    codex!.model = "gpt-5-codex";
    codex!.thinkingLevel = "high";

    const config = configFromDraft(draft);

    expect(config.judging).toEqual({
      mode: "manual"
    });
    expect(config.teams.map((team) => team.id)).toEqual(["red", "blue"]);
    expect(config.teams[0].agentIds).toEqual(["red-codex", "red-claude"]);
    expect(config.agents.map((agent) => agent.id)).toEqual(["red-codex", "blue-claude", "red-claude"]);
    expect(config.agents[0].instructions).toBe("Use goal mode aggressively.");
    expect(config.agents[0].model).toBe("gpt-5-codex");
    expect(config.agents[0].thinkingLevel).toBe("high");

    const review = reviewText(config, []);
    expect(review).toContain("- red-codex: codex, model gpt-5-codex, thinking high");
    expect(reviewJson(config)).toContain('"teams"');
  });

  it("warns about missing env resources and includes warnings in review text", () => {
    const draft = emptyDraft();
    draft.goal = "Ship the task.";
    draft.resources = [
      {
        type: "env",
        name: "Missing env",
        envVar: "AGENT_ARENA_TUI_TEST_MISSING_ENV",
        usage: "Use this env var for the missing service.",
        whenToUse: "Use when the task needs the service."
      }
    ];

    const warnings = draftWarnings(draft);
    expect(warnings[0]).toMatch(/AGENT_ARENA_TUI_TEST_MISSING_ENV/);
    expect(reviewText(configFromDraft(draft), warnings)).toContain("Warnings: 1");
  });

  it("treats saved secrets as available in warnings and review text", () => {
    const draft = emptyDraft();
    draft.goal = "Use GPU resources.";
    draft.resources = [
      {
        type: "env",
        name: "Vast.ai API key",
        envVar: "VASTAI_API_KEY",
        usage: "Rent GPU instances for heavy benchmark experiments.",
        whenToUse: "Use when local GPU/CUDA is unavailable or too slow."
      }
    ];
    const context = {
      processEnv: {},
      savedSecrets: {
        VASTAI_API_KEY: "redacted-secret"
      }
    };

    const warnings = draftWarnings(draft, context);
    const review = reviewText(configFromDraft(draft), warnings, context);

    expect(warnings).toEqual([]);
    expect(review).toContain("available from saved secret");
    expect(review).toContain("Rent GPU instances");
    expect(review).not.toContain("redacted-secret");
  });

  it("warns when resources have no usage directive", () => {
    const draft = emptyDraft();
    draft.goal = "Use external compute.";
    draft.resources = [
      {
        type: "gpu",
        name: "GPU provider"
      }
    ];

    const warnings = draftWarnings(draft);

    expect(warnings.some((warning) => warning.includes("no usage or whenToUse directive"))).toBe(true);
  });

  it("loads existing harness settings into the draft", () => {
    const config = configFromDraft({
      ...emptyDraft(),
      goal: "Ship it.",
      agents: emptyDraft().agents.map((agent) =>
        agent.id === "blue-claude"
          ? { ...agent, model: "sonnet", thinkingLevel: "max" }
          : agent.id === "red-codex"
            ? { ...agent, thinkingLevel: "xhigh" }
            : agent
      )
    });

    const draft = draftFromConfig(config);
    const claude = draft.agents.find((agent) => agent.id === "blue-claude");
    const codex = draft.agents.find((agent) => agent.id === "red-codex");

    expect(claude?.model).toBe("sonnet");
    expect(claude?.thinkingLevel).toBe("max");
    expect(codex?.thinkingLevel).toBe("xhigh");
  });

  it("assigns stable team accent colors from team ids and names", () => {
    expect(teamAccentColor({ id: "red", name: "Team Red" })).toBe("red");
    expect(teamAccentColor({ id: "blue", name: "Team Blue" })).toBe("blue");
    expect(teamAccentColor({ id: "research", name: "Paper Team" })).toBe(teamAccentColor({ id: "research", name: "Paper Team" }));
  });

  it("adds and removes teams while preserving minimum valid arena shape", () => {
    const draft = emptyDraft();
    const added = addTeamDraft(draft);

    expect(added.draft.teams.map((team) => team.id)).toContain(added.teamId);
    expect(added.draft.agents.find((agent) => agent.id === added.agentId)?.teamId).toBe(added.teamId);
    expect(configFromDraft(added.draft).teams.find((team) => team.id === added.teamId)?.agentIds).toEqual([added.agentId]);

    const removed = removeTeamDraft(added.draft, added.teamId);
    expect(removed.teams.map((team) => team.id)).toEqual(["red", "blue"]);
    expect(removed.agents.map((agent) => agent.id)).toEqual(["red-codex", "blue-claude"]);

    const blocked = removeTeamDraft(draft, "red");
    expect(blocked).toBe(draft);
  });

  it("adds configured team members and keeps captain assignment inside the team", () => {
    const draft = emptyDraft();
    const added = addAgentDraft(draft, "red", {
      preset: "claude",
      model: "sonnet",
      thinkingLevel: "max",
      codename: "Ada"
    });
    const withCaptain = setTeamCaptainDraft(added.draft, "red", added.agentId);
    const config = configFromDraft(withCaptain);

    expect(config.agents.find((agent) => agent.id === added.agentId)).toMatchObject({
      preset: "claude",
      model: "sonnet",
      thinkingLevel: "max",
      codename: "Ada"
    });
    expect(config.teams.find((team) => team.id === "red")?.captainAgentId).toBe(added.agentId);
    expect(setTeamCaptainDraft(withCaptain, "red", "blue-claude")).toBe(withCaptain);
  });

  it("blocks invalid member removal and reassigns captain when removing a captain", () => {
    const draft = emptyDraft();
    expect(removeAgentDraft(draft, "red-codex")).toBe(draft);

    const added = addAgentDraft(draft, "red", {
      preset: "claude",
      thinkingLevel: "high"
    });
    const withCaptain = setTeamCaptainDraft(added.draft, "red", added.agentId);
    const removedCaptain = removeAgentDraft(withCaptain, added.agentId);

    expect(removedCaptain.agents.some((agent) => agent.id === added.agentId)).toBe(false);
    expect(removedCaptain.teams.find((team) => team.id === "red")?.captainAgentId).toBe("red-codex");
  });
});
