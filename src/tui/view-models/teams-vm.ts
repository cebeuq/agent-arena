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

type AgentColumnWidths = {
  id: number;
  harness: number;
  model: number;
};

// Size the id/harness/model columns to their longest content when the
// terminal is wide enough, shrinking toward minimums on narrow terminals —
// fixed widths used to truncate "OpenAI Codex CLI" even at 120 columns.
function agentColumnWidths(draft: TuiDraft, columns: number): AgentColumnWidths {
  const harnessNames = draft.agents.map((agent) =>
    agent.preset ? agentPresets[agent.preset].displayName : "Custom command"
  );
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const fit = {
    id: clamp(Math.max(0, ...draft.agents.map((agent) => agent.id.length)), 10, 24),
    harness: clamp(Math.max(0, ...harnessNames.map((name) => name.length)), 11, 24),
    model: clamp(Math.max("CLI default".length, ...draft.agents.map((agent) => (agent.model ?? "").length)), 11, 28)
  };
  // marker(2) + separators(5) + thinking(6) + res(7) + panel chrome(~6) + codename slack(12)
  const overhead = 2 + 5 + 6 + 7 + 6 + 12;
  let excess = fit.id + fit.harness + fit.model + overhead - columns;
  for (const key of ["model", "harness", "id"] as const) {
    if (excess <= 0) {
      break;
    }
    const minimum = key === "harness" ? 11 : key === "model" ? 11 : 10;
    const give = Math.min(excess, fit[key] - minimum);
    fit[key] -= give;
    excess -= give;
  }
  return fit;
}

function agentRowLabel(draft: TuiDraft, team: TuiTeamDraft, agent: TuiAgentDraft, widths: AgentColumnWidths): string {
  const captainMark = team.captainAgentId === agent.id ? glyphs.captain : " ";
  const harness = agent.preset ? agentPresets[agent.preset].displayName : "Custom command";
  const model = agent.model ?? "CLI default";
  const codename = agent.codename ? `"${agent.codename}"` : "";
  return [
    `${captainMark} ${pad(agent.id, widths.id)}`,
    pad(harness, widths.harness),
    pad(model, widths.model),
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

export function buildTeamsItems(draft: TuiDraft, columns = 100): Array<SelectListItem<string>> {
  const widths = agentColumnWidths(draft, columns);
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
        label: agentRowLabel(draft, team, agent, widths)
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
