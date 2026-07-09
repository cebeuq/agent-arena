import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { agentPresets } from "../../presets.js";
import { selectSetupHelper } from "../../setup.js";
import { selectedAgentPresets } from "../../tui-model.js";
import { pluralize } from "../../format.js";
import { glyphs, theme } from "../theme.js";
import { hint } from "../keys/keymap.js";
import { useKeys } from "../keys/useKeys.js";
import { AppShell } from "../components/AppShell.js";
import { Panel } from "../components/Panel.js";
import { FieldRow } from "../components/FieldRow.js";
import { TextField } from "../components/TextField.js";
import { ListEditor } from "../components/ListEditor.js";
import { useEditorEscape } from "../components/editor-escape.js";
import { useModal } from "../components/ModalProvider.js";
import { useWizard } from "../app.js";
import { toggleJudgingMode } from "../view-models/teams-vm.js";

type FieldId = "helper" | "goal" | "doneWhen" | "judging" | "verifier" | "sharedResources";

export function TaskScreen(): React.ReactElement {
  const { state, dispatch, toast, showToast, requestExit } = useWizard();
  const modal = useModal();
  const openInEditor = useEditorEscape();
  const draft = state.draft;
  const [fieldIndex, setFieldIndex] = useState(0);
  const [editing, setEditing] = useState<"goal" | "verifier" | undefined>();
  // Local buffer for inline edits: committed to the draft only on Enter, so
  // Esc actually cancels instead of silently keeping every keystroke.
  const [editBuffer, setEditBuffer] = useState("");

  const helper = useMemo(() => selectSetupHelper(selectedAgentPresets(draft)), [draft.agents]);

  const fields: FieldId[] = ["helper", "goal", "doneWhen", "judging", "verifier", "sharedResources"];
  const selectedField = fields[fieldIndex];

  function setDraft(next: typeof draft): void {
    dispatch({ type: "setDraft", draft: next });
  }

  function launchHelper(feedback?: string): void {
    if (!helper) {
      showToast("No selected agent CLI is installed to act as setup helper.", "warn");
      return;
    }
    if (!state.repoRoot) {
      showToast("Select a project before launching the helper.", "warn");
      return;
    }
    requestExit({ kind: "helper", repoRoot: state.repoRoot, draft, helper, feedback });
  }

  function openDoneWhenEditor(): void {
    const handle = modal.openModal(
      () => (
        <ListEditorModal
          title="Done when (optional)"
          initial={draft.successCriteria}
          onDone={(items) => {
            handle.close();
            setDraft({ ...draft, successCriteria: items });
          }}
        />
      ),
      { width: 70 }
    );
  }

  function activate(field: FieldId): void {
    if (field === "helper") {
      launchHelper();
    } else if (field === "goal") {
      setEditBuffer(draft.goal);
      setEditing("goal");
    } else if (field === "doneWhen") {
      openDoneWhenEditor();
    } else if (field === "judging") {
      setDraft(toggleJudgingMode(draft));
    } else if (field === "verifier") {
      if (draft.judging.mode !== "verifier") {
        showToast("Switch judging to Verifier to set a verifier command.", "warn");
        return;
      }
      setEditBuffer(draft.judging.verifyCommand);
      setEditing("verifier");
    } else if (field === "sharedResources") {
      dispatch({ type: "push", route: { name: "resources", scope: { kind: "shared" } } });
    }
  }

  useKeys((input, key) => {
    if (editing) {
      return false; // TextField owns input.
    }
    if (key.upArrow) {
      setFieldIndex((current) => Math.max(0, current - 1));
      return true;
    }
    if (key.downArrow) {
      setFieldIndex((current) => Math.min(fields.length - 1, current + 1));
      return true;
    }
    if (key.return) {
      activate(selectedField);
      return true;
    }
    if (input === "e" && selectedField === "goal") {
      const edited = openInEditor(draft.goal);
      if (edited !== undefined) {
        setDraft({ ...draft, goal: edited.trim() });
      } else {
        showToast("No $EDITOR available; press Enter to edit inline.", "warn");
      }
      return true;
    }
    if (key.rightArrow) {
      dispatch({ type: "push", route: { name: "review" } });
      return true;
    }
    if (key.leftArrow) {
      dispatch({ type: "pop" });
      return true;
    }
    return false;
  });

  const judgingValue =
    draft.judging.mode === "manual"
      ? `${glyphs.radioOn} Manual   ${glyphs.radioOff} Verifier — captain claims, you accept the winner`
      : `${glyphs.radioOff} Manual   ${glyphs.radioOn} Verifier — a command decides`;

  const verifierDisabled = draft.judging.mode !== "verifier";
  const verifierValue =
    draft.judging.mode === "verifier" ? draft.judging.verifyCommand || "(required)" : "only used with Verifier judging";

  return (
    <AppShell
      title="Setup — Task"
      step={{ index: 3, total: 4 }}
      status={toast}
      onDisabledHint={(reason) => showToast(reason, "warn")}
      hints={[
        hint("↑↓", "Move"),
        hint("Enter", "Edit", { onPress: () => activate(selectedField) }),
        hint("←/→", "Back/Next", { onPress: () => dispatch({ type: "push", route: { name: "review" } }) }),
        hint("Esc", "Back")
      ]}
    >
      <Panel title="Recommended" tone="accent">
        <FieldRow label="Setup helper" selected={selectedField === "helper"} disabled={!helper} labelWidth={18}>
          <Text color={helper ? theme.active : theme.disabled}>
            {helper
              ? `Describe the task with ${agentPresets[helper].displayName} (opens tmux helper)`
              : "No selected agent CLI is installed."}
          </Text>
        </FieldRow>
        <Text color={theme.dim}>
          {"  "}The helper chats with you, inspects the repo, and fills in everything below.
        </Text>
      </Panel>
      <Panel title="Or fill in manually" flexGrow={1}>
        <FieldRow label="Goal" required selected={selectedField === "goal"}>
          {editing === "goal" ? (
            <TextField
              value={editBuffer}
              onChange={setEditBuffer}
              onSubmit={(goal) => {
                setDraft({ ...draft, goal });
                setEditing(undefined);
              }}
              onCancel={() => setEditing(undefined)}
              width={60}
              placeholder="What should the competing agents accomplish?"
            />
          ) : (
            <Text color={draft.goal.trim() ? undefined : theme.dim}>
              {draft.goal.trim() || "not set — Enter to edit"}
              <Text color={theme.dim}> (e: $EDITOR)</Text>
            </Text>
          )}
        </FieldRow>
        <FieldRow label="Done when" selected={selectedField === "doneWhen"}>
          <Text color={draft.successCriteria.length === 0 ? theme.dim : undefined}>
            {draft.successCriteria.length > 0
              ? `${pluralize(draft.successCriteria.length, "checkpoint")} — Enter to edit`
              : "optional — Enter to add checkpoints the captain verifies before claiming"}
          </Text>
        </FieldRow>
        <FieldRow label="Judging" selected={selectedField === "judging"}>
          <Text>{judgingValue}</Text>
        </FieldRow>
        <FieldRow
          label="Verifier command"
          required={draft.judging.mode === "verifier"}
          selected={selectedField === "verifier"}
          disabled={verifierDisabled}
          error={
            draft.judging.mode === "verifier" && !draft.judging.verifyCommand.trim()
              ? "Verifier judging needs a command that exits 0 for a winning claim."
              : undefined
          }
        >
          {editing === "verifier" && draft.judging.mode === "verifier" ? (
            <TextField
              value={editBuffer}
              onChange={setEditBuffer}
              onSubmit={(verifyCommand) => {
                setDraft({ ...draft, judging: { mode: "verifier", verifyCommand } });
                setEditing(undefined);
              }}
              onCancel={() => setEditing(undefined)}
              width={50}
              placeholder="npm test"
            />
          ) : (
            <Text color={verifierDisabled ? theme.disabled : undefined}>{verifierValue}</Text>
          )}
        </FieldRow>
        <FieldRow label="Shared resources" selected={selectedField === "sharedResources"}>
          <Text>{draft.resources.length} — Enter to manage</Text>
        </FieldRow>
      </Panel>
    </AppShell>
  );
}

function ListEditorModal({
  title,
  initial,
  onDone
}: {
  title: string;
  initial: string[];
  onDone: (items: string[]) => void;
}): React.ReactElement {
  const [items, setItems] = useState(initial);
  return (
    <Box flexDirection="column">
      <ListEditor items={items} onChange={setItems} label={title} width={62} onDone={() => onDone(items)} />
    </Box>
  );
}
