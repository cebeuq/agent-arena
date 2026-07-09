import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { agentPresets } from "../../presets.js";
import { builtInAgentIds, setTeamCaptainDraft } from "../../tui-model.js";
import type { AgentPresetId, AgentThinkingLevel } from "../../types.js";
import { theme } from "../theme.js";
import { hint } from "../keys/keymap.js";
import { useKeys } from "../keys/useKeys.js";
import { AppShell } from "../components/AppShell.js";
import { Panel } from "../components/Panel.js";
import { FieldRow } from "../components/FieldRow.js";
import { useEditorEscape } from "../components/editor-escape.js";
import { useModal } from "../components/ModalProvider.js";
import { openSelectPrompt, openTextPrompt } from "../components/prompts.js";
import { useWizard } from "../app.js";
import { agentModelChoices, thinkingChoices, updateAgentDraft } from "../view-models/teams-vm.js";

type FieldId = "harness" | "model" | "thinking" | "codename" | "team" | "captain" | "instructions" | "resources";

const FIELDS: FieldId[] = ["harness", "model", "thinking", "codename", "team", "captain", "instructions", "resources"];

export function AgentEditorScreen({ agentId }: { agentId: string }): React.ReactElement {
  const { state, dispatch, toast, showToast } = useWizard();
  const modal = useModal();
  const openInEditor = useEditorEscape();
  const [fieldIndex, setFieldIndex] = useState(0);
  const draft = state.draft;
  const agent = draft.agents.find((candidate) => candidate.id === agentId);
  const team = agent ? draft.teams.find((candidate) => candidate.id === agent.teamId) : undefined;

  useEffect(() => {
    setFieldIndex(0);
  }, [agentId]);

  useKeys((_input, key) => {
    if (key.upArrow) {
      setFieldIndex((current) => Math.max(0, current - 1));
      return true;
    }
    if (key.downArrow) {
      setFieldIndex((current) => Math.min(FIELDS.length - 1, current + 1));
      return true;
    }
    if (key.return) {
      activate(FIELDS[fieldIndex]);
      return true;
    }
    return false;
  });

  if (!agent) {
    return (
      <AppShell title="Setup — Edit agent" hints={[hint("Esc", "Back")]} status={toast}>
        <Panel title="Edit agent" tone="warning">
          <Text color={theme.error}>Unknown agent {agentId}.</Text>
        </Panel>
      </AppShell>
    );
  }

  const isCaptain = team?.captainAgentId === agent.id;
  const teamMembers = draft.agents.filter((candidate) => candidate.teamId === agent.teamId);

  function setAgent(update: Parameters<typeof updateAgentDraft>[2]): void {
    dispatch({ type: "setDraft", draft: updateAgentDraft(draft, agentId, update) });
  }

  function activate(field: FieldId): void {
    if (!agent) {
      return;
    }
    if (field === "harness") {
      void openSelectPrompt(modal, {
        title: "Harness",
        items: builtInAgentIds.map((preset) => ({ value: preset, label: agentPresets[preset].displayName })),
        selected: agent.preset
      }).then((preset) => {
        if (preset) {
          setAgent((current) => ({ ...current, preset: preset as AgentPresetId, model: undefined }));
        }
      });
    } else if (field === "model") {
      void openSelectPrompt(modal, {
        title: "Model",
        items: agentModelChoices(agent.preset).map((choice) => ({ value: choice.value, label: choice.label })),
        selected: agent.model ?? "__default__"
      }).then((model) => {
        if (!model) {
          return;
        }
        if (model === "__custom__") {
          void openTextPrompt(modal, {
            title: "Custom model id",
            label: "Exact model id accepted by this harness.",
            initial: agent.model ?? ""
          }).then((custom) => {
            if (custom !== undefined) {
              setAgent((current) => ({ ...current, model: custom.trim() || undefined }));
            }
          });
          return;
        }
        setAgent((current) => ({ ...current, model: model === "__default__" ? undefined : model }));
      });
    } else if (field === "thinking") {
      void openSelectPrompt(modal, {
        title: "Thinking level",
        items: thinkingChoices(agent.preset).map((choice) => ({ value: choice.value, label: choice.label })),
        selected: agent.thinkingLevel
      }).then((level) => {
        if (level) {
          setAgent((current) => ({ ...current, thinkingLevel: level as AgentThinkingLevel }));
        }
      });
    } else if (field === "codename") {
      void openTextPrompt(modal, {
        title: "Codename",
        label: "Visible name for this agent. Leave empty for automatic assignment.",
        initial: agent.codename ?? ""
      }).then((codename) => {
        if (codename !== undefined) {
          setAgent((current) => ({ ...current, codename: codename.trim() || undefined }));
        }
      });
    } else if (field === "team") {
      if (teamMembers.length <= 1) {
        showToast("Cannot move: this agent is its team's last member.", "warn");
        return;
      }
      void openSelectPrompt(modal, {
        title: "Move to team",
        items: draft.teams.map((candidate) => ({ value: candidate.id, label: candidate.name })),
        selected: agent.teamId
      }).then((teamId) => {
        if (teamId && teamId !== agent.teamId) {
          setAgent((current) => ({ ...current, teamId }));
        }
      });
    } else if (field === "captain") {
      if (isCaptain) {
        showToast("This agent is already the team captain.", "info");
        return;
      }
      dispatch({ type: "setDraft", draft: setTeamCaptainDraft(draft, agent.teamId, agent.id) });
      showToast(`${agent.id} is now captain.`, "info");
    } else if (field === "instructions") {
      const edited = openInEditor(agent.instructions ?? "");
      if (edited !== undefined) {
        setAgent((current) => ({ ...current, instructions: edited.trim() || undefined }));
        return;
      }
      void openTextPrompt(modal, {
        title: `Instructions for ${agent.id}`,
        label: "Shown only to this agent. Leave empty to clear.",
        initial: agent.instructions ?? "",
        width: 70
      }).then((instructions) => {
        if (instructions !== undefined) {
          setAgent((current) => ({ ...current, instructions: instructions.trim() || undefined }));
        }
      });
    } else if (field === "resources") {
      dispatch({ type: "push", route: { name: "resources", scope: { kind: "agent", agentId: agent.id } } });
    }
  }

  const values: Record<FieldId, string> = {
    harness: agentPresets[agent.preset].displayName,
    model: agent.model ?? "CLI default",
    thinking: agent.thinkingLevel,
    codename: agent.codename ?? "(auto-assigned)",
    team: team ? `${team.name} (${team.id})` : agent.teamId,
    captain: isCaptain ? "yes — submits the final claim" : "no — press Enter to make captain",
    instructions: agent.instructions?.trim()
      ? agent.instructions.trim().slice(0, 50) + (agent.instructions.trim().length > 50 ? "…" : "")
      : "none — Enter to edit",
    resources: `${agent.resources.length} — Enter to manage`
  };

  const labels: Record<FieldId, string> = {
    harness: "Harness",
    model: "Model",
    thinking: "Thinking",
    codename: "Codename",
    team: "Team",
    captain: "Captain",
    instructions: "Instructions",
    resources: "Resources"
  };

  return (
    <AppShell
      title={`Setup — Edit agent ${agent.id}`}
      status={toast}
      onDisabledHint={(reason) => showToast(reason, "warn")}
      hints={[
        hint("↑↓", "Move"),
        hint("Enter", "Edit", { onPress: () => activate(FIELDS[fieldIndex]) }),
        hint("Esc", "Back", { onPress: () => dispatch({ type: "pop" }) })
      ]}
    >
      <Panel title={`${agent.codename ?? agent.id} on ${team?.name ?? agent.teamId}`} flexGrow={1}>
        <Box flexDirection="column">
          {FIELDS.map((field, index) => (
            <FieldRow key={field} label={labels[field]} selected={index === fieldIndex}>
              <Text color={index === fieldIndex ? theme.active : undefined}>{values[field]}</Text>
            </FieldRow>
          ))}
        </Box>
        <Text> </Text>
        <Text color={theme.dim}>Changes apply immediately. Esc returns to the team table.</Text>
      </Panel>
    </AppShell>
  );
}
