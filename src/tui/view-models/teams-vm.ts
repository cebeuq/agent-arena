import { agentPresets } from "../../presets.js";
import { teamAccentColor, type TuiAgentDraft, type TuiDraft, type TuiTeamDraft } from "../../tui-model.js";
import type { AgentPresetId, AgentThinkingLevel } from "../../types.js";
import { glyphs } from "../theme.js";
import type { SelectListItem } from "../components/SelectList.js";

export type SelectChoice<T extends string = string> = {
  label: string;
  value: T;
};

export function agentModelChoices(presetId: AgentPresetId): Array<SelectChoice<string>> {
  const common: Array<SelectChoice<string>> = [
    {
      label: "Use CLI default",
      value: "__default__"
    }
  ];

  const vendorChoices: Record<AgentPresetId, Array<SelectChoice<string>>> = {
    claude: [
      { label: "Claude Sonnet alias (sonnet)", value: "sonnet" },
      { label: "Claude Opus alias (opus)", value: "opus" }
    ],
    codex: [
      { label: "GPT-5 Codex (gpt-5-codex)", value: "gpt-5-codex" },
      { label: "Codex Mini latest (codex-mini-latest)", value: "codex-mini-latest" }
    ],
    cursor: [
      { label: "Grok 4.5 Fast (grok-4.5-fast-xhigh)", value: "grok-4.5-fast-xhigh" },
      { label: "Grok 4.5 (grok-4.5-xhigh)", value: "grok-4.5-xhigh" },
      { label: "Codex 5.3 (gpt-5.3-codex)", value: "gpt-5.3-codex" }
    ]
  };

  return [
    ...common,
    ...vendorChoices[presetId],
    {
      label: "Custom model id",
      value: "__custom__"
    }
  ];
}

export function thinkingChoices(presetId: AgentPresetId): Array<SelectChoice<AgentThinkingLevel>> {
  const common: Array<SelectChoice<AgentThinkingLevel>> = [
    { label: "Auto / CLI default", value: "auto" },
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" }
  ];
  return presetId === "codex"
    ? [...common, { label: "Extra high (xhigh)", value: "xhigh" }]
    : [...common, { label: "Max", value: "max" }];
}

export function updateAgentDraft(
  draft: TuiDraft,
  agentId: string,
  update: (agent: TuiAgentDraft) => TuiAgentDraft
): TuiDraft {
  return {
    ...draft,
    agents: draft.agents.map((agent) => (agent.id === agentId ? update(agent) : agent))
  };
}

export function updateTeamDraft(
  draft: TuiDraft,
  teamId: string,
  update: (team: TuiTeamDraft) => TuiTeamDraft
): TuiDraft {
  return {
    ...draft,
    teams: draft.teams.map((team) => (team.id === teamId ? update(team) : team))
  };
}

export type TeamsRowRef =
  | { kind: "team"; teamId: string }
  | { kind: "agent"; agentId: string };

export function parseTeamsRowValue(value: string): TeamsRowRef {
  if (value.startsWith("team:")) {
    return { kind: "team", teamId: value.slice("team:".length) };
  }
  return { kind: "agent", agentId: value.slice("agent:".length) };
}

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

function agentRowLabel(draft: TuiDraft, team: TuiTeamDraft, agent: TuiAgentDraft): string {
  const captainMark = team.captainAgentId === agent.id ? glyphs.captain : " ";
  const harness = agentPresets[agent.preset].displayName;
  const model = agent.model ?? "CLI default";
  const codename = agent.codename ? `"${agent.codename}"` : "";
  return [
    `${captainMark} ${pad(agent.id, 18)}`,
    pad(harness, 13),
    pad(model, 17),
    pad(agent.thinkingLevel, 6),
    pad(`res:${agent.resources.length}`, 7),
    codename
  ].join(" ");
}

function teamRowLabel(draft: TuiDraft, team: TuiTeamDraft): string {
  const members = draft.agents.filter((agent) => agent.teamId === team.id);
  const resources = (team.resources?.length ?? 0) + members.reduce((total, agent) => total + agent.resources.length, 0);
  const notes = team.instructions?.trim() ? " · instructions set" : "";
  return `▼ ${team.name} (${team.id}) — ${members.length} agent${members.length === 1 ? "" : "s"} · ${resources} resource${
    resources === 1 ? "" : "s"
  }${notes}`;
}

export function buildTeamsItems(draft: TuiDraft): Array<SelectListItem<string>> {
  return draft.teams.flatMap((team) => {
    const members = draft.agents.filter((agent) => agent.teamId === team.id);
    const accent = teamAccentColor(team);
    return [
      {
        value: `team:${team.id}`,
        label: teamRowLabel(draft, team),
        accentColor: accent
      },
      ...members.map((agent) => ({
        value: `agent:${agent.id}`,
        label: agentRowLabel(draft, team, agent)
      }))
    ];
  });
}

export function toggleJudgingMode(draft: TuiDraft): TuiDraft {
  if (draft.judging.mode === "manual") {
    return {
      ...draft,
      judging: {
        mode: "verifier",
        verifyCommand: "npm test"
      }
    };
  }
  return {
    ...draft,
    judging: {
      mode: "manual"
    }
  };
}
