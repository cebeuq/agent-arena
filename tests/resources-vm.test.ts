import { describe, expect, it } from "vitest";
import { parseArenaConfig } from "../src/config.js";
import { configFromDraft, emptyDraft } from "../src/tui-model.js";
import type { ArenaResource } from "../src/types.js";
import {
  RESOURCE_TYPES,
  blankResource,
  resourceFieldSpecs,
  scopedResources,
  validateResource,
  withScopedResources
} from "../src/tui/view-models/resources-vm.js";

const SAMPLE_VALUES: Record<string, string> = {
  name: "Sample resource",
  envVar: "SAMPLE_API_KEY",
  host: "host.example.com",
  user: "deploy",
  path: "data/sample.txt",
  url: "https://example.com/data",
  provider: "aws",
  notes: "A note for agents.",
  usage: "Use it when the task needs it.",
  whenToUse: "When local capabilities fall short.",
  description: "Sample description.",
  budget: "$5",
  cleanup: "Tear down when done.",
  verification: "Run a redacted check."
};

function completedResource(type: ArenaResource["type"]): ArenaResource {
  let resource = blankResource(type);
  for (const spec of resourceFieldSpecs(type)) {
    resource = { ...resource, [spec.key]: SAMPLE_VALUES[spec.key] };
  }
  return resource;
}

describe("resource field specs round-trip", () => {
  it.each(RESOURCE_TYPES)("a completed %s form validates and survives parseArenaConfig", (type) => {
    const resource = completedResource(type);
    expect(validateResource(resource)).toEqual({});

    const draft = { ...emptyDraft(), goal: "test goal", resources: [resource] };
    const config = configFromDraft(draft);
    const reparsed = parseArenaConfig(JSON.parse(JSON.stringify(config)));
    expect(reparsed.resources).toHaveLength(1);
    expect(reparsed.resources[0].type).toBe(type);
    expect(reparsed.resources[0].name).toBe(SAMPLE_VALUES.name);
  });

  it("rejects env resources without a valid env var name", () => {
    expect(validateResource({ type: "env", name: "Key" })).toHaveProperty("envVar");
    expect(validateResource({ type: "env", name: "Key", envVar: "not a name!" })).toHaveProperty("envVar");
    expect(validateResource({ type: "env", name: "Key", envVar: "GOOD_NAME" })).toEqual({});
  });

  it("requires a name everywhere and per-type required fields", () => {
    expect(validateResource({ type: "url", name: "" })).toHaveProperty("name");
    expect(validateResource({ type: "url", name: "Docs" })).toHaveProperty("url");
    expect(validateResource({ type: "ssh", name: "Box" })).toHaveProperty("host");
    expect(validateResource({ type: "file", name: "Data" })).toHaveProperty("path");
    expect(validateResource({ type: "dataset", name: "Set" })).toHaveProperty("path");
    expect(validateResource({ type: "dataset", name: "Set", url: "https://x" })).toEqual({});
  });
});

describe("scoped resources", () => {
  it("reads and writes shared, team, and agent scopes", () => {
    const draft = { ...emptyDraft(), goal: "g" };
    const resource = completedResource("env");

    const shared = withScopedResources(draft, { kind: "shared" }, [resource]);
    expect(scopedResources(shared, { kind: "shared" })).toEqual([resource]);

    const teamId = draft.teams[0].id;
    const team = withScopedResources(draft, { kind: "team", teamId }, [resource]);
    expect(scopedResources(team, { kind: "team", teamId })).toEqual([resource]);

    const agentId = draft.agents[0].id;
    const agent = withScopedResources(draft, { kind: "agent", agentId }, [resource]);
    expect(scopedResources(agent, { kind: "agent", agentId })).toEqual([resource]);

    // Round-trip through the config builder keeps team and agent placement.
    const config = configFromDraft(withScopedResources(agent, { kind: "team", teamId }, [resource]));
    expect(config.agents.find((candidate) => candidate.id === agentId)?.resources).toHaveLength(1);
    expect(config.teams.find((candidate) => candidate.id === teamId)?.resources).toHaveLength(1);
  });
});
