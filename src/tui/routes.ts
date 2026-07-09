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
  | { name: "task" }
  | { name: "review" };

export const WIZARD_STEPS: Array<{ route: Route["name"]; title: string }> = [
  { route: "project", title: "Project" },
  { route: "teams", title: "Teams & Agents" },
  { route: "task", title: "Task" },
  { route: "review", title: "Review & Start" }
];

export function stepForRoute(route: Route): { index: number; total: number } | undefined {
  const index = WIZARD_STEPS.findIndex((step) => step.route === route.name);
  if (index === -1) {
    return undefined;
  }
  return { index: index + 1, total: WIZARD_STEPS.length };
}
