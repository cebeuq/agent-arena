import { describe, expect, it } from "vitest";
import { assignCodenames, CODENAME_POOL } from "../src/codenames.js";
import type { AgentInput } from "../src/types.js";

function agent(id: string, codename?: string): AgentInput {
  return {
    id,
    preset: "codex",
    goalMode: "auto",
    codename
  };
}

describe("codename assignment", () => {
  it("preserves provided codenames and assigns unique deterministic missing names", () => {
    const agents = [agent("red-codex", "Nova"), agent("red-claude"), agent("blue-codex")];

    const first = assignCodenames(agents, "run-1");
    const second = assignCodenames(agents, "run-1");

    expect(first).toEqual(second);
    expect(first["red-codex"]).toBe("Nova");
    expect(new Set(Object.values(first))).toHaveLength(3);
    expect(Object.values(first).filter((name) => name !== "Nova").every((name) => CODENAME_POOL.includes(name))).toBe(true);
  });

  it("falls back to generated labels after the built-in pool is exhausted", () => {
    const agents = Array.from({ length: CODENAME_POOL.length + 2 }, (_, index) => agent(`agent-${index}`));

    const codenames = assignCodenames(agents, "large-run");

    expect(new Set(Object.values(codenames))).toHaveLength(agents.length);
    expect(Object.values(codenames)).toContain("Agent1");
    expect(Object.values(codenames)).toContain("Agent2");
  });
});
