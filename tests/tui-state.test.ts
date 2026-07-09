import { describe, expect, it } from "vitest";
import { currentRoute, initialWizardState, wizardReducer, type WizardState } from "../src/tui/state.js";
import { emptyDraft } from "../src/tui-model.js";

function baseState(): WizardState {
  return initialWizardState({ repoRoot: "/tmp/repo" });
}

describe("wizard reducer", () => {
  it("starts on the project route with a clean draft", () => {
    const state = baseState();
    expect(currentRoute(state).name).toBe("project");
    expect(state.dirty).toBe(false);
  });

  it("pushes and pops routes, never popping the last one", () => {
    let state = baseState();
    state = wizardReducer(state, { type: "push", route: { name: "teams" } });
    state = wizardReducer(state, { type: "push", route: { name: "task" } });
    expect(currentRoute(state).name).toBe("task");

    state = wizardReducer(state, { type: "pop" });
    expect(currentRoute(state).name).toBe("teams");
    state = wizardReducer(state, { type: "pop" });
    state = wizardReducer(state, { type: "pop" });
    expect(currentRoute(state).name).toBe("project");
    expect(state.stack).toHaveLength(1);
  });

  it("marks the draft dirty on edits and clean after a project load", () => {
    let state = baseState();
    state = wizardReducer(state, { type: "setDraft", draft: { ...emptyDraft(), goal: "win" } });
    expect(state.dirty).toBe(true);

    state = wizardReducer(state, { type: "projectLoaded", repoRoot: "/tmp/other" });
    expect(state.dirty).toBe(false);
    expect(state.repoRoot).toBe("/tmp/other");
  });

  it("replaces the stack only with a non-empty one", () => {
    let state = baseState();
    state = wizardReducer(state, { type: "replaceStack", stack: [] });
    expect(state.stack).toHaveLength(1);
    state = wizardReducer(state, {
      type: "replaceStack",
      stack: [{ name: "project" }, { name: "teams" }]
    });
    expect(currentRoute(state).name).toBe("teams");
  });

  it("restores a helper-resume stack from init", () => {
    const state = initialWizardState({
      repoRoot: "/tmp/repo",
      draft: { ...emptyDraft(), goal: "from helper" },
      stack: [{ name: "project" }, { name: "teams" }, { name: "task" }, { name: "review" }],
      notices: ["helper warning"]
    });
    expect(currentRoute(state).name).toBe("review");
    expect(state.draft.goal).toBe("from helper");
    expect(state.notices).toEqual(["helper warning"]);
    expect(state.dirty).toBe(true);
  });
});
