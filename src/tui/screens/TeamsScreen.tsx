import React, { useEffect, useMemo } from "react";
import { Box, Text } from "ink";
import {
  addAgentDraft,
  addTeamDraft,
  removeAgentDraft,
  removeTeamDraft,
  setTeamCaptainDraft
} from "../../tui-model.js";
import { theme } from "../theme.js";
import { hint } from "../keys/keymap.js";
import { useKeys } from "../keys/useKeys.js";
import { AppShell } from "../components/AppShell.js";
import { Panel } from "../components/Panel.js";
import { SelectList } from "../components/SelectList.js";
import { useEditorEscape } from "../components/editor-escape.js";
import { useModal } from "../components/ModalProvider.js";
import { openSelectPrompt, openTextPrompt } from "../components/prompts.js";
import { useTerminalSize } from "../components/useTerminalSize.js";
import { useWizard } from "../app.js";
import { buildTeamsItems, parseTeamsRowValue, updateTeamDraft } from "../view-models/teams-vm.js";

export function TeamsScreen(): React.ReactElement {
  const { state, dispatch, toast, showToast } = useWizard();
  const modal = useModal();
  const openInEditor = useEditorEscape();
  const { rows, columns } = useTerminalSize();
  const draft = state.draft;
  const items = useMemo(() => buildTeamsItems(draft, columns), [draft, columns]);
  // Selection lives in wizard state (not useState) so it survives this screen
  // unmounting while the agent editor is open — otherwise Esc-ing back would
  // land on the first agent and a quick `d` would delete the wrong row.
  const selected = state.teamsSelection ?? items.find((item) => item.value.startsWith("agent:"))?.value;
  const setSelected = (value: string | undefined): void => {
    dispatch({ type: "setTeamsSelection", value });
  };

  useEffect(() => {
    if (!selected || !items.some((item) => item.value === selected)) {
      setSelected(items.find((item) => item.value.startsWith("agent:"))?.value ?? items[0]?.value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, selected]);

  const selectedRef = selected ? parseTeamsRowValue(selected) : undefined;
  const selectedTeamId =
    selectedRef?.kind === "team"
      ? selectedRef.teamId
      : selectedRef?.kind === "agent"
        ? draft.agents.find((agent) => agent.id === selectedRef.agentId)?.teamId
        : undefined;

  function setDraft(next: typeof draft): void {
    dispatch({ type: "setDraft", draft: next });
  }

  function addAgent(): void {
    const teamId = selectedTeamId ?? draft.teams[0]?.id;
    if (!teamId) {
      showToast("Create a team first.", "warn");
      return;
    }
    const result = addAgentDraft(draft, teamId, { preset: "codex" });
    setDraft(result.draft);
    setSelected(`agent:${result.agentId}`);
    dispatch({ type: "push", route: { name: "agentEditor", agentId: result.agentId } });
  }

  function addTeam(): void {
    const result = addTeamDraft(draft);
    setDraft(result.draft);
    setSelected(`team:${result.teamId}`);
    showToast(`Added ${result.teamId} with one codex agent.`, "info");
  }

  function makeCaptain(): void {
    if (selectedRef?.kind !== "agent") {
      showToast("Select an agent row to set a captain.", "warn");
      return;
    }
    const agent = draft.agents.find((candidate) => candidate.id === selectedRef.agentId);
    if (!agent) {
      return;
    }
    setDraft(setTeamCaptainDraft(draft, agent.teamId, agent.id));
    showToast(`${agent.id} is now captain.`, "info");
  }

  function removeSelected(): void {
    if (!selectedRef) {
      return;
    }
    if (selectedRef.kind === "agent") {
      const next = removeAgentDraft(draft, selectedRef.agentId);
      if (next === draft) {
        showToast("Cannot remove: each team needs at least one agent and the arena needs two agents.", "warn");
        return;
      }
      void modal
        .confirm({
          title: "Remove agent",
          message: `Remove ${selectedRef.agentId}? This cannot be undone.`,
          confirmLabel: "Remove",
          danger: true
        })
        .then((confirmed) => {
          if (confirmed) {
            setDraft(removeAgentDraft(draft, selectedRef.agentId));
            showToast(`Removed ${selectedRef.agentId}.`, "info");
          } else {
            showToast("Cancelled — nothing removed.", "info");
          }
        });
      return;
    }
    const next = removeTeamDraft(draft, selectedRef.teamId);
    if (next === draft) {
      showToast("Cannot remove: the arena needs at least two teams.", "warn");
      return;
    }
    void modal
      .confirm({
        title: "Remove team",
        message: `Remove team ${selectedRef.teamId} and all its agents? This cannot be undone.`,
        confirmLabel: "Remove",
        danger: true
      })
      .then((confirmed) => {
        if (confirmed) {
          setDraft(removeTeamDraft(draft, selectedRef.teamId));
          showToast(`Removed team ${selectedRef.teamId}.`, "info");
        } else {
          showToast("Cancelled — nothing removed.", "info");
        }
      });
  }

  function openTeamMenu(teamId: string): void {
    const team = draft.teams.find((candidate) => candidate.id === teamId);
    if (!team) {
      return;
    }
    void openSelectPrompt(modal, {
      title: `${team.name} (${team.id})`,
      items: [
        { value: "rename", label: "Rename team" },
        { value: "instructions", label: `Team instructions (${team.instructions?.trim() ? "set" : "none"})` },
        { value: "resources", label: `Team resources (${team.resources?.length ?? 0})` },
        { value: "remove", label: "Remove team" }
      ]
    }).then((action) => {
      if (action === "rename") {
        void openTextPrompt(modal, {
          title: "Team name",
          initial: team.name,
          validate: (value) => (value.trim() ? undefined : "Team name cannot be empty.")
        }).then((name) => {
          if (name?.trim()) {
            setDraft(updateTeamDraft(draft, teamId, (current) => ({ ...current, name: name.trim() })));
          }
        });
      } else if (action === "instructions") {
        const edited = openInEditor(team.instructions ?? "");
        if (edited !== undefined) {
          setDraft(updateTeamDraft(draft, teamId, (current) => ({ ...current, instructions: edited.trim() || undefined })));
          return;
        }
        void openTextPrompt(modal, {
          title: `Instructions for ${team.name}`,
          label: "Shown only to this team's agents. Leave empty to clear.",
          initial: team.instructions ?? "",
          width: 70
        }).then((instructions) => {
          if (instructions !== undefined) {
            setDraft(updateTeamDraft(draft, teamId, (current) => ({ ...current, instructions: instructions.trim() || undefined })));
          }
        });
      } else if (action === "resources") {
        dispatch({ type: "push", route: { name: "resources", scope: { kind: "team", teamId } } });
      } else if (action === "remove") {
        const next = removeTeamDraft(draft, teamId);
        if (next === draft) {
          showToast("Cannot remove: the arena needs at least two teams.", "warn");
          return;
        }
        void modal
          .confirm({
            title: "Remove team",
            message: `Remove ${team.name} and all its agents? This cannot be undone.`,
            confirmLabel: "Remove",
            danger: true
          })
          .then((confirmed) => {
            if (confirmed) {
              setDraft(removeTeamDraft(draft, teamId));
              showToast(`Removed ${team.name}.`, "info");
            } else {
              showToast("Cancelled — nothing removed.", "info");
            }
          });
      }
    });
  }

  function activate(value: string): void {
    const ref = parseTeamsRowValue(value);
    if (ref.kind === "agent") {
      dispatch({ type: "push", route: { name: "agentEditor", agentId: ref.agentId } });
    } else {
      openTeamMenu(ref.teamId);
    }
  }

  function goNext(): void {
    dispatch({ type: "push", route: { name: "task" } });
  }

  useKeys((input, key) => {
    if (input === "a") {
      addAgent();
      return true;
    }
    if (input === "t") {
      addTeam();
      return true;
    }
    if (input === "c") {
      makeCaptain();
      return true;
    }
    if (input === "d") {
      removeSelected();
      return true;
    }
    if (key.rightArrow) {
      goNext();
      return true;
    }
    if (key.leftArrow) {
      dispatch({ type: "pop" });
      return true;
    }
    return false;
  });

  const listHeight = Math.max(6, rows - 12);

  return (
    <AppShell
      title="Setup — Teams & Agents"
      step={{ index: 2, total: 4 }}
      status={toast}
      onDisabledHint={(reason) => showToast(reason, "warn")}
      hints={[
        hint("↑↓", "Move"),
        hint("Enter", "Edit", { onPress: () => selected && activate(selected) }),
        hint("a", "Add agent", { onPress: addAgent }),
        hint("t", "Add team", { onPress: addTeam }),
        hint("c", "Captain", { onPress: makeCaptain }),
        hint("d", "Delete", { onPress: removeSelected }),
        hint("←/→", "Back/Next", { onPress: goNext }),
        hint("Esc", "Back")
      ]}
    >
      <Panel title="Teams and agents" flexGrow={1}>
        <SelectList
          items={items}
          selected={selected}
          onSelect={setSelected}
          onActivate={activate}
          height={listHeight}
          onDisabledActivate={(reason) => showToast(reason, "warn")}
        />
        <Text> </Text>
        <Text color={theme.dim}>
          Enter on an agent opens its editor. Enter on a team row opens team actions. {"♛"} marks the captain who
          submits final claims.
        </Text>
      </Panel>
    </AppShell>
  );
}
