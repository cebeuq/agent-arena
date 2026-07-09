import type { AgentInput } from "./types.js";

export const CODENAME_POOL = [
  "Ada",
  "Ari",
  "Aster",
  "Atlas",
  "Blair",
  "Cato",
  "Cleo",
  "Dara",
  "Eden",
  "Ellis",
  "Ember",
  "Ezra",
  "Finn",
  "Gray",
  "Harper",
  "Iris",
  "Jules",
  "Kai",
  "Lane",
  "Lena",
  "Mara",
  "Milo",
  "Nova",
  "Nico",
  "Orion",
  "Pax",
  "Quinn",
  "Reese",
  "Remy",
  "Riley",
  "Rowan",
  "Sage",
  "Skye",
  "Sol",
  "Talia",
  "Theo",
  "Vale",
  "Vega",
  "Wren",
  "Zara"
];

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function stablePool(runId: string): string[] {
  return [...CODENAME_POOL].sort((left, right) => hash(`${runId}:${left}`) - hash(`${runId}:${right}`));
}

export function assignCodenames(agents: AgentInput[], runId: string): Record<string, string> {
  const assigned: Record<string, string> = {};
  const used = new Set<string>();

  for (const agent of agents) {
    if (agent.codename?.trim()) {
      assigned[agent.id] = agent.codename.trim();
      used.add(agent.codename.trim().toLowerCase());
    }
  }

  const pool = stablePool(runId);
  let fallback = 1;
  for (const agent of agents) {
    if (assigned[agent.id]) {
      continue;
    }

    const name = pool.find((candidate) => !used.has(candidate.toLowerCase()));
    if (name) {
      assigned[agent.id] = name;
      used.add(name.toLowerCase());
      continue;
    }

    const generated = `Agent${fallback}`;
    fallback += 1;
    assigned[agent.id] = generated;
    used.add(generated.toLowerCase());
  }

  return assigned;
}
