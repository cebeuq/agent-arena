import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { agentPresets } from "../../presets.js";
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

function buildItems(snapshot: RunSnapshot): Array<SelectListItem<string>> {
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
            `${agent.isCaptain ? glyphs.captain : " "} ${pad(`${agent.codename} (${agent.id})`, 26)}`,
            pad(harness, 13),
            pad(agent.model ?? "default", 14),
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
  const { rows } = useTerminalSize();
  const items = useMemo(() => buildItems(snapshot), [snapshot]);
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
        <Text color={theme.dim}>
          Enter opens chat with the agent (or judging when it has a pending claim). o opens the agent's terminal
          pane. j judges.
        </Text>
      </Panel>
      <Panel title={selectedAgent ? `${selectedAgent.codename} (${selectedAgent.id})` : "No agent selected"}>
        {selectedAgent ? (
          <Box flexDirection="column">
            <Text color={theme.dim} wrap="truncate">
              branch {selectedAgent.branch} · workspace {selectedAgent.workspace}
            </Text>
            <Text wrap="truncate">
              {selectedProgress?.changedFiles.length ?? 0} changed file(s)
              {selectedProgress?.changedFiles.length
                ? `: ${selectedProgress.changedFiles.slice(0, 5).join(", ")}${selectedProgress.changedFiles.length > 5 ? "…" : ""}`
                : ""}
              {snapshot.progressUpdatedAt ? `  (updated ${snapshot.progressUpdatedAt.slice(11, 19)})` : ""}
            </Text>
            <Text wrap="truncate">
              latest claim: {latestClaim ? `${latestClaim.status} at ${latestClaim.claimedAt}` : "none"}
            </Text>
          </Box>
        ) : (
          <Text color={theme.dim}>Select an agent row above.</Text>
        )}
      </Panel>
    </Box>
  );
}
