import {
  describeAvailability,
  describeResource,
  resolveResourcesAvailability,
  type ResourceAvailabilityContext
} from "../../resources.js";
import type { ArenaConfig, ArenaResource } from "../../types.js";

export type ReviewLine = {
  text: string;
  tone?: "title" | "dim" | "warning";
};

function title(text: string): ReviewLine {
  return { text, tone: "title" };
}

function dim(text: string): ReviewLine {
  return { text, tone: "dim" };
}

function plain(text: string): ReviewLine {
  return { text };
}

function blank(): ReviewLine {
  return { text: "" };
}

function listOrNone(items: string[]): ReviewLine[] {
  if (items.length === 0) {
    return [dim("  none")];
  }
  return items.map((item) => plain(`  - ${item}`));
}

function resourceLines(resources: ArenaResource[], context: ResourceAvailabilityContext, indent = "  "): ReviewLine[] {
  if (resources.length === 0) {
    return [dim(`${indent}none`)];
  }
  return resolveResourcesAvailability(resources, context).map((availability) => {
    const line = `${indent}- ${describeResource(availability.resource)} [${describeAvailability(availability)}]`;
    return availability.status === "missing" ? { text: line, tone: "warning" as const } : plain(line);
  });
}

export function reviewSections(
  config: ArenaConfig,
  warnings: string[],
  context: ResourceAvailabilityContext = {}
): ReviewLine[] {
  const lines: ReviewLine[] = [];

  lines.push(title("Goal"));
  lines.push(plain(`  ${config.goal}`));
  lines.push(blank());

  lines.push(title(`Teams (${config.teams.length}) · Agents (${config.agents.length})`));
  for (const team of config.teams) {
    const members = team.agentIds
      .map((agentId) => {
        const agent = config.agents.find((candidate) => candidate.id === agentId);
        if (!agent) {
          return agentId;
        }
        const label = agent.codename ?? agent.name ?? agent.id;
        return `${label} (${agent.id}, ${agent.preset ?? "custom"})${agent.id === team.captainAgentId ? " captain" : ""}`;
      })
      .join(", ");
    lines.push(plain(`  - ${team.name} (${team.id}): ${members || "no agents"}`));
    if (team.instructions?.trim()) {
      lines.push(dim(`    instructions: ${team.instructions.trim()}`));
    }
  }
  lines.push(blank());

  lines.push(title("Judging"));
  lines.push(
    plain(
      config.judging.mode === "verifier"
        ? `  verifier — ${config.judging.verifyCommand}`
        : "  manual — the captain claims, you accept the winner"
    )
  );
  lines.push(blank());

  lines.push(title(`Done when (${config.successCriteria.length})`));
  lines.push(...listOrNone(config.successCriteria));
  lines.push(blank());

  lines.push(title("Shared resources"));
  lines.push(...resourceLines(config.resources, context));
  const teamsWithResources = config.teams.filter((team) => (team.resources ?? []).length > 0);
  for (const team of teamsWithResources) {
    lines.push(plain(`  ${team.name}:`));
    lines.push(...resourceLines(team.resources ?? [], context, "    "));
  }
  const agentsWithResources = config.agents.filter((agent) => (agent.resources ?? []).length > 0);
  for (const agent of agentsWithResources) {
    lines.push(plain(`  ${agent.id}:`));
    lines.push(...resourceLines(agent.resources ?? [], { ...context, agentEnv: agent.env }, "    "));
  }
  lines.push(blank());

  lines.push(title("Harness settings"));
  for (const agent of config.agents) {
    lines.push(
      plain(
        `  - ${agent.codename ? `${agent.codename} ` : ""}${agent.id}: ${agent.preset ?? "custom"}, model ${
          agent.model ?? "default"
        }, thinking ${agent.thinkingLevel ?? "auto"}`
      )
    );
    if (agent.instructions?.trim()) {
      lines.push(dim(`    instructions: ${agent.instructions.trim()}`));
    }
  }
  lines.push(blank());

  if (warnings.length > 0) {
    lines.push(title(`Warnings (${warnings.length})`));
    for (const warning of warnings) {
      lines.push({ text: `  ! ${warning}`, tone: "warning" });
    }
  }

  return lines;
}
