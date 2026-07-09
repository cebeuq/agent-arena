import { parseArenaConfig } from "./config.js";
import { DEFAULT_EXCLUDES, DEFAULT_INCLUDE } from "./defaults.js";
import {
  describeAvailability,
  describeResource,
  resolveResourcesAvailability,
  resourceOrderWarnings,
  resourceWarnings
} from "./resources.js";
import type { ResourceAvailabilityContext } from "./resources.js";
import type {
  AgentInput,
  AgentPresetId,
  AgentThinkingLevel,
  ArenaConfig,
  ArenaResource,
  GoalMode,
  JudgingConfig,
  TeamInput
} from "./types.js";

export const builtInAgentIds = ["claude", "codex", "cursor"] as const satisfies AgentPresetId[];
export const teamAccentColors = ["red", "blue", "green", "yellow", "magenta", "cyan", "white"] as const;

export type TuiAgentDraft = {
  id: string;
  name?: string;
  codename?: string;
  // Exactly one of preset/command identifies the harness: a built-in preset
  // or a raw shell command (custom harness).
  preset?: AgentPresetId;
  command?: string;
  teamId: string;
  goalMode: GoalMode;
  model?: string;
  thinkingLevel: AgentThinkingLevel;
  instructions?: string;
  resources: ArenaResource[];
};

export type TuiTeamDraft = {
  id: string;
  name: string;
  captainAgentId: string;
  instructions?: string;
  resources: ArenaResource[];
};

export type TuiDraft = {
  teams: TuiTeamDraft[];
  agents: TuiAgentDraft[];
  goal: string;
  successCriteria: string[];
  resources: ArenaResource[];
  judging: JudgingConfig;
};

export function makeAgentId(teamId: string, preset: AgentPresetId | undefined, existing: Iterable<string> = []): string {
  const used = new Set(existing);
  const base = `${teamId}-${preset ?? "custom"}`;
  if (!used.has(base)) {
    return base;
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export function teamAccentColor(team: Pick<TuiTeamDraft, "id" | "name">): string {
  const value = `${team.id} ${team.name}`.toLowerCase();
  if (value.includes("red")) {
    return "red";
  }
  if (value.includes("blue")) {
    return "blue";
  }
  if (value.includes("green")) {
    return "green";
  }
  if (value.includes("yellow")) {
    return "yellow";
  }
  if (value.includes("purple")) {
    return "magenta";
  }
  if (value.includes("cyan")) {
    return "cyan";
  }
  return teamAccentColors[hashString(value) % teamAccentColors.length];
}

export type AddAgentDraftOptions = {
  preset?: AgentPresetId;
  command?: string;
  model?: string;
  thinkingLevel?: AgentThinkingLevel;
  codename?: string;
};

export function addAgentDraft(
  draft: TuiDraft,
  teamId: string,
  options: AddAgentDraftOptions
): { draft: TuiDraft; agentId: string } {
  const id = makeAgentId(teamId, options.preset, draft.agents.map((agent) => agent.id));
  return {
    draft: {
      ...draft,
      agents: [
        ...draft.agents,
        {
          id,
          preset: options.preset,
          command: options.command,
          teamId,
          goalMode: "auto",
          model: options.model,
          thinkingLevel: options.thinkingLevel ?? "auto",
          codename: options.codename || undefined,
          resources: []
        }
      ]
    },
    agentId: id
  };
}

export function addTeamDraft(draft: TuiDraft): { draft: TuiDraft; teamId: string; agentId: string } {
  const existing = new Set(draft.teams.map((team) => team.id));
  let index = draft.teams.length + 1;
  let teamId = `team-${index}`;
  while (existing.has(teamId)) {
    index += 1;
    teamId = `team-${index}`;
  }
  const agent = addAgentDraft(draft, teamId, {
    preset: "codex",
    thinkingLevel: "auto"
  });
  return {
    draft: {
      ...agent.draft,
      teams: [
        ...draft.teams,
        {
          id: teamId,
          name: `Team ${index}`,
          captainAgentId: agent.agentId,
          resources: []
        }
      ]
    },
    teamId,
    agentId: agent.agentId
  };
}

export function removeTeamDraft(draft: TuiDraft, teamId: string): TuiDraft {
  const agentsToRemove = new Set(draft.agents.filter((agent) => agent.teamId === teamId).map((agent) => agent.id));
  const remainingTeams = draft.teams.filter((team) => team.id !== teamId);
  const remainingAgents = draft.agents.filter((agent) => !agentsToRemove.has(agent.id));
  if (remainingTeams.length < 2 || remainingAgents.length < 2) {
    return draft;
  }
  return {
    ...draft,
    teams: remainingTeams,
    agents: remainingAgents
  };
}

export function removeAgentDraft(draft: TuiDraft, agentId: string): TuiDraft {
  const agent = draft.agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    return draft;
  }
  const members = draft.agents.filter((candidate) => candidate.teamId === agent.teamId);
  if (draft.agents.length <= 2 || members.length <= 1) {
    return draft;
  }
  const agents = draft.agents.filter((candidate) => candidate.id !== agentId);
  const nextCaptain = agents.find((candidate) => candidate.teamId === agent.teamId)?.id;
  return {
    ...draft,
    agents,
    teams: draft.teams.map((team) =>
      team.id === agent.teamId && team.captainAgentId === agentId && nextCaptain
        ? {
            ...team,
            captainAgentId: nextCaptain
          }
        : team
    )
  };
}

export function setTeamCaptainDraft(draft: TuiDraft, teamId: string, agentId: string): TuiDraft {
  if (!draft.agents.some((agent) => agent.id === agentId && agent.teamId === teamId)) {
    return draft;
  }
  return {
    ...draft,
    teams: draft.teams.map((team) => (team.id === teamId ? { ...team, captainAgentId: agentId } : team))
  };
}

export function emptyDraft(): TuiDraft {
  return {
    teams: [
      {
        id: "red",
        name: "Team Red",
        captainAgentId: "red-codex",
        resources: []
      },
      {
        id: "blue",
        name: "Team Blue",
        captainAgentId: "blue-claude",
        resources: []
      }
    ],
    agents: [
      {
        id: "red-codex",
        preset: "codex",
        teamId: "red",
        goalMode: "auto",
        thinkingLevel: "auto",
        resources: []
      },
      {
        id: "blue-claude",
        preset: "claude",
        teamId: "blue",
        goalMode: "auto",
        thinkingLevel: "auto",
        resources: []
      }
    ],
    goal: "",
    successCriteria: [],
    resources: [],
    judging: {
      mode: "manual"
    }
  };
}

export function draftFromSelectedPresets(selectedAgents: AgentPresetId[]): TuiDraft {
  const draft = emptyDraft();
  const teams = selectedAgents.map((preset, index) => {
    const teamId = index === 0 ? "red" : index === 1 ? "blue" : `team-${index + 1}`;
    const teamName = index === 0 ? "Team Red" : index === 1 ? "Team Blue" : `Team ${index + 1}`;
    const agentId = makeAgentId(teamId, preset);
    return {
      team: {
        id: teamId,
        name: teamName,
        captainAgentId: agentId,
        resources: []
      } satisfies TuiTeamDraft,
      agent: {
        id: agentId,
        preset,
        teamId,
        goalMode: "auto",
        thinkingLevel: "auto",
        resources: []
      } satisfies TuiAgentDraft
    };
  });

  return {
    ...draft,
    teams: teams.map((entry) => entry.team),
    agents: teams.map((entry) => entry.agent)
  };
}

function teamIdForAgent(teams: TeamInput[], agentId: string): string | undefined {
  return teams.find((team) => team.agentIds.includes(agentId))?.id;
}

export function draftFromConfig(config?: ArenaConfig): TuiDraft {
  if (!config) {
    return emptyDraft();
  }

  const fallback = emptyDraft();
  const teams: TuiTeamDraft[] =
    config.teams.length > 0
      ? config.teams.map((team) => ({
          id: team.id,
          name: team.name,
          captainAgentId: team.captainAgentId,
          instructions: team.instructions,
          resources: team.resources ?? []
        }))
      : fallback.teams;

  const agents: TuiAgentDraft[] = config.agents.flatMap((agent) => {
    const preset = agent.preset && builtInAgentIds.includes(agent.preset) ? agent.preset : undefined;
    // Custom-command agents are first-class; only drop agents with neither a
    // known preset nor a command (nothing could launch them).
    if (!preset && !agent.command) {
      return [];
    }
    return [
      {
        id: agent.id,
        name: agent.name,
        codename: agent.codename,
        preset,
        command: agent.command,
        teamId: teamIdForAgent(config.teams, agent.id) ?? teams[0]?.id ?? "red",
        goalMode: agent.goalMode,
        model: agent.model,
        thinkingLevel: agent.thinkingLevel ?? "auto",
        instructions: agent.instructions,
        resources: agent.resources ?? []
      }
    ];
  });

  return {
    ...fallback,
    teams,
    agents: agents.length >= 2 ? agents : fallback.agents,
    goal: config.goal,
    successCriteria: config.successCriteria,
    resources: config.resources,
    judging: config.judging
  };
}

export function selectedAgentPresets(draft: TuiDraft): AgentPresetId[] {
  return [...new Set(draft.agents.flatMap((agent) => (agent.preset ? [agent.preset] : [])))];
}

function teamAgentIds(draft: TuiDraft, teamId: string): string[] {
  return draft.agents.filter((agent) => agent.teamId === teamId).map((agent) => agent.id);
}

function normalizeCaptain(draft: TuiDraft, team: TuiTeamDraft): string {
  const agentIds = teamAgentIds(draft, team.id);
  if (agentIds.includes(team.captainAgentId)) {
    return team.captainAgentId;
  }
  return agentIds[0] ?? team.captainAgentId;
}

export function configFromDraft(draft: TuiDraft): ArenaConfig {
  const agents: AgentInput[] = draft.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    codename: agent.codename,
    preset: agent.preset,
    command: agent.command,
    goalMode: agent.goalMode,
    model: agent.model,
    thinkingLevel: agent.thinkingLevel,
    instructions: agent.instructions,
    resources: agent.resources
  }));

  const teams: TeamInput[] = draft.teams.map((team) => ({
    id: team.id,
    name: team.name,
    captainAgentId: normalizeCaptain(draft, team),
    agentIds: teamAgentIds(draft, team.id),
    instructions: team.instructions,
    resources: team.resources
  }));

  return parseArenaConfig({
    baseRepo: ".",
    baseRef: "HEAD",
    goal: draft.goal.trim() || "Describe the task and measurable win condition here.",
    successCriteria: draft.successCriteria,
    resources: draft.resources,
    judging: draft.judging,
    teams,
    agents,
    peek: {
      refreshIntervalSeconds: 30,
      include: DEFAULT_INCLUDE,
      exclude: DEFAULT_EXCLUDES
    },
    tmux: {
      sessionPrefix: "agent-arena",
      attach: true
    }
  });
}

export function draftWarnings(draft: TuiDraft, context: ResourceAvailabilityContext = {}): string[] {
  const warnings = [
    ...resourceWarnings(draft.resources, "shared resource", context),
    ...resourceOrderWarnings(draft.resources, "shared resource")
  ];

  if (draft.teams.length < 2) {
    warnings.push("Create at least two teams.");
  }

  if (draft.agents.length < 2) {
    warnings.push("Create at least two agents.");
  }

  const agentIds = new Set<string>();
  for (const agent of draft.agents) {
    if (agentIds.has(agent.id)) {
      warnings.push(`Agent id ${agent.id} is duplicated.`);
    }
    agentIds.add(agent.id);
    warnings.push(...resourceWarnings(agent.resources, `${agent.id} resource`, context));
    warnings.push(...resourceOrderWarnings(agent.resources, `${agent.id} resource`));
  }

  for (const team of draft.teams) {
    const members = draft.agents.filter((agent) => agent.teamId === team.id);
    if (members.length === 0) {
      warnings.push(`${team.name} has no agents.`);
      continue;
    }
    if (!members.some((agent) => agent.id === team.captainAgentId)) {
      warnings.push(`${team.name} needs a captain from its own agents.`);
    }
    warnings.push(...resourceWarnings(team.resources, `${team.id} team resource`, context));
    warnings.push(...resourceOrderWarnings(team.resources, `${team.id} team resource`));
  }

  if (!draft.goal.trim()) {
    warnings.push("Goal is empty; the generated config will use placeholder text.");
  }

  if (draft.judging.mode === "verifier" && !draft.judging.verifyCommand.trim()) {
    warnings.push("Verifier mode requires a verifier command.");
  }

  return warnings;
}

function resourceReviewLines(resources: ArenaResource[], context: ResourceAvailabilityContext): string[] {
  if (resources.length === 0) {
    return ["- none"];
  }

  return resolveResourcesAvailability(resources, context).map(
    (availability) => `- ${describeResource(availability.resource)} [${describeAvailability(availability)}]`
  );
}

function resourceOrderReviewLines(resources: ArenaResource[]): string[] {
  if (resources.length === 0) {
    return ["- none"];
  }

  return resources.map((resource) => {
    const usage = resource.usage ?? "usage not specified";
    const when = resource.whenToUse ?? "trigger not specified";
    return `- ${resource.name}: ${usage}; when: ${when}`;
  });
}

export function teamSummaryLines(config: ArenaConfig): string[] {
  return config.teams.flatMap((team) => {
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
    return [`- ${team.name} (${team.id})`, `  captain: ${team.captainAgentId}`, `  agents: ${members || "none"}`];
  });
}

export function reviewText(config: ArenaConfig, warnings: string[], context: ResourceAvailabilityContext = {}): string {
  const lines = [
    `Teams: ${config.teams.length}`,
    `Agents: ${config.agents.length}`,
    `Judging: ${config.judging.mode}`,
    "",
    "Teams:",
    ...teamSummaryLines(config),
    "",
    `Goal: ${config.goal}`,
    "",
    "Done when:",
    ...(config.successCriteria.length > 0 ? config.successCriteria.map((item) => `- ${item}`) : ["- none"]),
    "",
    "Shared resources:",
    ...resourceReviewLines(config.resources, context),
    "",
    "Team resources:",
    ...config.teams.flatMap((team) => [
      `- ${team.name}:`,
      ...resourceReviewLines(team.resources ?? [], context).map((line) => `  ${line}`)
    ]),
    "",
    "Agent resources:",
    ...config.agents.flatMap((agent) => {
      const resources = agent.resources ?? [];
      return [`- ${agent.id}:`, ...resourceReviewLines(resources, { ...context, agentEnv: agent.env }).map((line) => `  ${line}`)];
    }),
    "",
    "Resource orders:",
    "Shared:",
    ...resourceOrderReviewLines(config.resources),
    "Teams:",
    ...config.teams.flatMap((team) => [
      `- ${team.name}:`,
      ...resourceOrderReviewLines(team.resources ?? []).map((line) => `  ${line}`)
    ]),
    "Agents:",
    ...config.agents.flatMap((agent) => [
      `- ${agent.id}:`,
      ...resourceOrderReviewLines(agent.resources ?? []).map((line) => `  ${line}`)
    ]),
    "",
    "Harness settings:",
    ...config.agents.map(
      (agent) =>
        `- ${agent.codename ? `${agent.codename} ` : ""}${agent.id}: ${agent.preset ?? "custom"}, model ${
          agent.model ?? "default"
        }, thinking ${agent.thinkingLevel ?? "auto"}`
    ),
    "",
    "Team instructions:",
    ...config.teams.map((team) => `- ${team.name}: ${team.instructions?.trim() || "none"}`),
    "",
    "Agent instructions:",
    ...config.agents.map((agent) => `- ${agent.id}: ${agent.instructions?.trim() || "none"}`),
    "",
    `Warnings: ${warnings.length}`
  ];

  return lines.join("\n");
}

export function reviewJson(config: ArenaConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

