import React, { useEffect, useMemo, useState } from "react";
import { existsSync } from "node:fs";
import { Box, Text } from "ink";
import { resolveGitRoot } from "../../worktree.js";
import { draftFromConfig } from "../../tui-model.js";
import { theme } from "../theme.js";
import { hint } from "../keys/keymap.js";
import { AppShell } from "../components/AppShell.js";
import { Panel } from "../components/Panel.js";
import { SelectList, type SelectListItem } from "../components/SelectList.js";
import { useModal } from "../components/ModalProvider.js";
import { openTextPrompt } from "../components/prompts.js";
import { useWizard } from "../app.js";
import { freshDraft } from "../state.js";
import { createProject, selectProject } from "./project-actions.js";
import { loadProjectSummary, type ProjectSummary } from "../view-models/project-vm.js";

type SourceValue = "__edit__" | "__new__" | "__browse__" | "__manual__";

function field(label: string, value: string, color?: string): React.ReactElement {
  return (
    <Text key={label + value}>
      <Text color={theme.dim}>{label.padEnd(16)}</Text>
      <Text color={color}>{value}</Text>
    </Text>
  );
}

export function ProjectScreen(): React.ReactElement {
  const { state, dispatch, toast, showToast, requestExit } = useWizard();
  const modal = useModal();
  const [summary, setSummary] = useState<ProjectSummary | undefined>();

  useEffect(() => {
    let cancelled = false;
    void loadProjectSummary(state.repoRoot).then((loaded) => {
      if (!cancelled) {
        setSummary(loaded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [state.repoRoot]);

  const items = useMemo<Array<SelectListItem<SourceValue>>>(() => {
    const list: Array<SelectListItem<SourceValue>> = [];
    if (state.repoRoot) {
      if (state.existingConfig) {
        list.push({ value: "__edit__", label: "Edit existing arena.config.json" });
      }
      list.push({
        value: "__new__",
        label: state.existingConfig ? "New setup for this project" : "Use this project"
      });
    }
    list.push({ value: "__browse__", label: "Browse for a folder…" });
    list.push({ value: "__manual__", label: "Type a path…" });
    return list;
  }, [state.repoRoot, state.existingConfig]);

  const [selected, setSelected] = useState<SourceValue | undefined>(() => items[0]?.value);

  useEffect(() => {
    if (!selected || !items.some((item) => item.value === selected)) {
      setSelected(items[0]?.value);
    }
  }, [items, selected]);

  const actions = { dispatch, showToast };

  function activate(value: SourceValue): void {
    if (value === "__edit__") {
      dispatch({ type: "setDraft", draft: draftFromConfig(state.existingConfig), markDirty: false });
      dispatch({ type: "push", route: { name: "teams" } });
      return;
    }
    if (value === "__new__") {
      dispatch({ type: "setDraft", draft: freshDraft(), markDirty: false });
      dispatch({ type: "push", route: { name: "teams" } });
      return;
    }
    if (value === "__browse__") {
      dispatch({ type: "push", route: { name: "browse" } });
      return;
    }
    // __manual__: type a path directly (fast when you know it).
    void openTextPrompt(modal, {
      title: "Project path",
      label: "Absolute path, relative path, or . for the current directory.",
      placeholder: "/path/to/repo",
      // Inline validation keeps the prompt (and the typed path) open on a
      // bad entry instead of discarding it behind a toast.
      validate: (value) => {
        const candidate = value.trim();
        if (!candidate) {
          return undefined;
        }
        if (!existsSync(candidate)) {
          return "Path does not exist.";
        }
        try {
          resolveGitRoot(candidate);
          return undefined;
        } catch {
          return "Not a git repository.";
        }
      }
    }).then((entered) => {
      if (entered?.trim()) {
        void selectProject(actions, entered.trim());
      }
    });
  }

  return (
    <AppShell
      title="Setup — Project"
      step={{ index: 1, total: 4 }}
      status={toast ?? (state.configError ? { text: state.configError, tone: "error" } : undefined)}
      onDisabledHint={(reason) => showToast(reason, "warn")}
      hints={[
        hint("↑↓", "Move"),
        hint("Enter", "Select", { onPress: () => selected && activate(selected) }),
        hint("Esc", "Quit", { onPress: () => requestExit({ kind: "quit" }) })
      ]}
    >
      {/* flexGrow fills the shell body so the panels reach the footer instead
          of leaving a large dead zone on tall terminals. */}
      <Box flexGrow={1}>
        <Box flexDirection="column" width="50%">
          <Panel title="Where will the arena run?" flexGrow={1}>
            <SelectList
              items={items}
              selected={selected}
              onSelect={(value) => setSelected(value)}
              onActivate={activate}
              height={Math.max(4, items.length)}
            />
            <Text> </Text>
            <Text color={theme.dim}>Agent Arena runs inside a git repository.</Text>
          </Panel>
          {state.notices.length > 0 ? (
            <Panel title="Notices" tone="warning">
              {state.notices.map((notice) => (
                <Text key={notice} color={theme.warning} wrap="wrap">
                  {notice}
                </Text>
              ))}
            </Panel>
          ) : null}
        </Box>
        <Box flexDirection="column" width="50%">
          <Panel title="Project info" flexGrow={1}>
            {field("Path", summary?.path ?? state.repoRoot ?? "none selected", summary ? undefined : theme.dim)}
            {field("Git", summary?.isGitRepo ? "repository" : "not selected", summary?.isGitRepo ? theme.success : theme.dim)}
            {field("Branch", summary?.defaultBranch ?? "unknown")}
            {field("Dirty tree", summary ? (summary.dirty ? "yes" : "no") : "unknown", summary?.dirty ? theme.warning : undefined)}
            {field("Remote", summary?.remotes[0] ?? "none")}
            {field("Runs", String(summary?.runCount ?? 0))}
            {field("Workspaces", `${summary?.activeWorkspaces ?? 0} active`)}
            <Text> </Text>
            {state.existingConfig ? (
              <Text>
                <Text color={theme.success}>arena.config.json found</Text>
                <Text color={theme.dim}>
                  {" "}· {state.existingConfig.teams.length} teams · {state.existingConfig.agents.length} agents
                </Text>
              </Text>
            ) : (
              <Text color={theme.dim}>No arena.config.json loaded.</Text>
            )}
          </Panel>
        </Box>
      </Box>
    </AppShell>
  );
}
