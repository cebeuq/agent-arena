import type { ArenaResourceType } from "../types.js";

export type ResourceScope =
  | { kind: "shared" }
  | { kind: "team"; teamId: string }
  | { kind: "agent"; agentId: string };

export type Route =
  | { name: "project" }
  | { name: "teams" }
  | { name: "agentEditor"; agentId: string }
  | { name: "resources"; scope: ResourceScope }
  | { name: "resourceForm"; scope: ResourceScope; index?: number; newType?: ArenaResourceType }
  | { name: "browse" }
  | { name: "task" }
  | { name: "review" };

export const WIZARD_STEPS: Array<{ route: Route["name"]; title: string }> = [
  { route: "project", title: "Project" },
  { route: "teams", title: "Teams & Agents" },
  { route: "task", title: "Task" },
  { route: "review", title: "Review & Start" }
];

// Sub-screens belong to a wizard step too: the agent editor and resource
// screens are all part of Teams & Agents (except shared resources, edited
// from the Task step).
function parentStepRoute(route: Route): Route["name"] {
  if (route.name === "browse") {
    return "project";
  }
  if (route.name === "agentEditor") {
    return "teams";
  }
  if (route.name === "resources" || route.name === "resourceForm") {
    return route.scope.kind === "shared" ? "task" : "teams";
  }
  return route.name;
}

export function stepForRoute(route: Route): { index: number; total: number } | undefined {
  const index = WIZARD_STEPS.findIndex((step) => step.route === parentStepRoute(route));
  if (index === -1) {
    return undefined;
  }
  return { index: index + 1, total: WIZARD_STEPS.length };
}
