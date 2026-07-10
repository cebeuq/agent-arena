import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { agentPresets } from "../../presets.js";
import { formatLocalTime, pluralize } from "../../format.js";
import { glyphs, theme } from "../theme.js";
import { useKeys } from "../keys/useKeys.js";
import { Panel } from "../components/Panel.js";
import { SelectList, type SelectListItem } from "../components/SelectList.js";
import { useTerminalSize } from "../components/useTerminalSize.js";
import { agentRunState, runTeamsOf, unreadCountForAgent } from "./model.js";
import { useOverseer } from "./overseer-app.js";
import type { RunSnapshot } from "./run-watcher.js";

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

function stateLabel(state: ReturnType<typeof agentRunState>): string {
  if (state === "claimed") {
    return "claimed!";
  }
  return state;
}

function buildItems(snapshot: RunSnapshot, columns: number): Array<SelectListItem<string>> {
  // Content-fit columns: fixed widths used to truncate "OpenAI Codex CLI"
  // regardless of terminal width. Shrinks toward minimums on narrow terminals.
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const widths = {
    name: clamp(
      Math.max(0, ...snapshot.state.agents.map((agent) => `${agent.codename} (${agent.id})`.length)),
      18,
      34
    ),
    harness: clamp(
      Math.max(0, ...snapshot.state.agents.map((agent) => (agent.preset ? agentPresets[agent.preset].displayName : "custom").length)),
      11,
      20
    ),
    model: clamp(Math.max("default".length, ...snapshot.state.agents.map((agent) => (agent.model ?? "").length)), 9, 20)
  };
  // marker(2) + separators(6) + state(9) + files(9) + claims(9) + chrome(~6) + unread slack(10)
  let excess = widths.name + widths.harness + widths.model + 51 - columns;
  for (const key of ["name", "model", "harness"] as const) {
    if (excess <= 0) {
      break;
    }
    const minimum = key === "name" ? 18 : key === "model" ? 9 : 11;
    const give = Math.min(excess, widths[key] - minimum);
    widths[key] -= give;
    excess -= give;
  }

  return runTeamsOf(snapshot.state).flatMap((team) => {
    const members = snapshot.state.agents.filter((agent) => team.agentIds.includes(agent.id));
    return [
      {
        value: `team:${team.id}`,
        label: `▼ ${team.name} (${team.id})`,
        header: true
      },
      ...members.map((agent) => {
        const progress = snapshot.progress.find((candidate) => candidate.agentId === agent.id);
        const runState = agentRunState(snapshot, agent.id);
        const unread = unreadCountForAgent(snapshot, agent.id);
        const harness = agent.preset ? agentPresets[agent.preset].displayName : "custom";
        return {
          value: `agent:${agent.id}`,
          label: [
            `${agent.isCaptain ? glyphs.captain : " "} ${pad(`${agent.codename} (${agent.id})`, widths.name)}`,
            pad(harness, widths.harness),
            pad(agent.model ?? "default", widths.model),
            pad(stateLabel(runState), 9),
            pad(`files:${progress?.changedFiles.length ?? 0}`, 9),
            pad(`claims:${progress?.claimCount ?? 0}`, 9),
            unread > 0 ? `unread:${unread}` : ""
          ].join(" "),
          accentColor:
            runState === "claimed" ? theme.warning : runState === "winner" ? theme.success : undefined
        };
      })
    ];
  });
}

export function DashboardView(): React.ReactElement {
  const { snapshot, openChat, openJudge, openAgentPane, showToast } = useOverseer();
  const { rows, columns } = useTerminalSize();
  const items = useMemo(() => buildItems(snapshot, columns), [snapshot, columns]);
  const [selected, setSelected] = useState<string | undefined>(
    items.find((item) => !item.header)?.value
  );

  useEffect(() => {
    if (!selected || !items.some((item) => item.value === selected)) {
      setSelected(items.find((item) => !item.header)?.value);
    }
  }, [items, selected]);

  const selectedAgentId = selected?.startsWith("agent:") ? selected.slice("agent:".length) : undefined;
  const selectedAgent = snapshot.state.agents.find((agent) => agent.id === selectedAgentId);
  const selectedProgress = snapshot.progress.find((candidate) => candidate.agentId === selectedAgentId);
  const latestClaim = selectedAgentId
    ? [...snapshot.state.claims].reverse().find((claim) => claim.agentId === selectedAgentId)
    : undefined;

  useKeys((input) => {
    if (input === "j") {
      if (selectedAgent && agentRunState(snapshot, selectedAgent.id) === "claimed") {
        openJudge(selectedAgent.id);
      } else {
        openJudge();
      }
      return true;
    }
    if (input === "o" && selectedAgent) {
      openAgentPane(selectedAgent.id);
      return true;
    }
    return false;
  });

  function activate(value: string): void {
    if (!value.startsWith("agent:")) {
      return;
    }
    const agentId = value.slice("agent:".length);
    if (agentRunState(snapshot, agentId) === "claimed") {
      openJudge(agentId);
      return;
    }
    openChat(`dm:${agentId}`);
  }

  const listHeight = Math.max(4, rows - 16);
  // On short terminals every extra line pushes the detail panel out of the
  // clipped viewport, so tighten the chrome instead of dropping the panel.
  const compact = rows < 28;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Panel title="Teams & agents" flexGrow={1}>
        <SelectList
          items={items}
          selected={selected}
          onSelect={setSelected}
          onActivate={activate}
          height={listHeight}
          onDisabledActivate={(reason) => showToast(reason, "warn")}
        />
        <Text color={theme.dim} wrap="truncate">
          Enter chats (or judges a claim). o peeks at the agent's live pane (Alt-q closes the peek). j judges.
        </Text>
      </Panel>
      <Panel title={selectedAgent ? `${selectedAgent.codename} (${selectedAgent.id})` : "No agent selected"}>
        {selectedAgent ? (
          <Box flexDirection="column">
            {compact ? null : (
              <Text color={theme.dim} wrap="truncate">
                branch {selectedAgent.branch} · workspace {selectedAgent.workspace}
              </Text>
            )}
            <Text wrap="truncate">
              {pluralize(selectedProgress?.changedFiles.length ?? 0, "changed file")}
              {selectedProgress?.changedFiles.length
                ? `: ${selectedProgress.changedFiles.slice(0, 5).join(", ")}${selectedProgress.changedFiles.length > 5 ? "…" : ""}`
                : ""}
              {snapshot.progressUpdatedAt ? `  (updated ${formatLocalTime(snapshot.progressUpdatedAt, { seconds: true })})` : ""}
            </Text>
            <Text wrap="truncate">
              latest claim: {latestClaim ? `${latestClaim.status} at ${formatLocalTime(latestClaim.claimedAt, { date: true })}` : "none"}
            </Text>
          </Box>
        ) : (
          <Text color={theme.dim}>Select an agent row above.</Text>
        )}
      </Panel>
    </Box>
  );
}
