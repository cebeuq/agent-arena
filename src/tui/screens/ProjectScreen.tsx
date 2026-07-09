import React, { useEffect, useMemo, useState } from "react";
import { existsSync } from "node:fs";
import { Box, Text } from "ink";
import { createNewProject } from "../../setup.js";
import { resolveGitRoot } from "../../worktree.js";
import { draftFromConfig } from "../../tui-model.js";
import { theme } from "../theme.js";
import { hint } from "../keys/keymap.js";
import { AppShell } from "../components/AppShell.js";
import { Panel } from "../components/Panel.js";
import { SelectList, type SelectListItem } from "../components/SelectList.js";
import { useModal } from "../components/ModalProvider.js";
import { openSelectPrompt, openTextPrompt } from "../components/prompts.js";
import { useWizard } from "../app.js";
import { freshDraft } from "../state.js";
import { loadExistingConfig, loadProjectSummary, type ProjectSummary } from "../view-models/project-vm.js";

type SourceValue = "__edit__" | "__new__" | "__pick__" | "__manual__" | "__create__";

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
    if (state.projectCandidates.length > 0) {
      list.push({ value: "__pick__", label: `Pick a nearby repo… (${state.projectCandidates.length} found)` });
    }
    list.push({ value: "__manual__", label: "Enter a path…" });
    list.push({ value: "__create__", label: "Create a new project…" });
    return list;
  }, [state.repoRoot, state.existingConfig, state.projectCandidates]);

  const [selected, setSelected] = useState<SourceValue | undefined>(() => items[0]?.value);

  useEffect(() => {
    if (!selected || !items.some((item) => item.value === selected)) {
      setSelected(items[0]?.value);
    }
  }, [items, selected]);

  async function selectProject(candidate: string): Promise<void> {
    dispatch({ type: "setBusy", busy: { label: `Loading ${candidate}…` } });
    try {
      const resolvedRoot = resolveGitRoot(candidate);
      const loaded = await loadExistingConfig(resolvedRoot);
      dispatch({
        type: "projectLoaded",
        repoRoot: resolvedRoot,
        config: loaded.existingConfig,
        error: loaded.existingConfigError
      });
      if (loaded.existingConfigError) {
        showToast(loaded.existingConfigError, "error");
      } else {
        showToast(`Loaded ${resolvedRoot}`, "info");
      }
    } catch {
      showToast(
        existsSync(candidate) ? "That path is not inside a git repository." : "That path does not exist.",
        "error"
      );
    } finally {
      dispatch({ type: "setBusy", busy: undefined });
    }
  }

  async function createProject(target: string): Promise<void> {
    dispatch({ type: "setBusy", busy: { label: `Creating ${target}…` } });
    try {
      const created = await createNewProject(target);
      const loaded = await loadExistingConfig(created.repoRoot);
      dispatch({
        type: "projectLoaded",
        repoRoot: created.repoRoot,
        config: loaded.existingConfig,
        error: loaded.existingConfigError
      });
      dispatch({ type: "setNotices", notices: created.warnings });
      showToast(`Created ${created.repoRoot}`, "info");
    } catch (error) {
      showToast((error as Error).message, "error");
    } finally {
      dispatch({ type: "setBusy", busy: undefined });
    }
  }

  function activate(value: SourceValue): void {
    if (value === "__edit__") {
      dispatch({ type: "setDraft", draft: draftFromConfig(state.existingConfig) });
      dispatch({ type: "push", route: { name: "teams" } });
      return;
    }
    if (value === "__new__") {
      dispatch({ type: "setDraft", draft: freshDraft() });
      dispatch({ type: "push", route: { name: "teams" } });
      return;
    }
    if (value === "__pick__") {
      void openSelectPrompt(modal, {
        title: "Pick a repository",
        items: state.projectCandidates.map((candidate) => ({ value: candidate, label: candidate })),
        height: Math.min(12, state.projectCandidates.length)
      }).then((picked) => {
        if (picked) {
          void selectProject(picked);
        }
      });
      return;
    }
    if (value === "__manual__") {
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
          void selectProject(entered.trim());
        }
      });
      return;
    }
    void openTextPrompt(modal, {
      title: "Create new project",
      label: "Creates a git repo with README.md and .gitignore.",
      placeholder: "/path/to/new-project"
    }).then((entered) => {
      if (entered?.trim()) {
        void createProject(entered.trim());
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
                <Text color={theme.success}>arena.config.json found </Text>
                <Text color={theme.dim}>
                  Teams: {state.existingConfig.teams.length} Agents: {state.existingConfig.agents.length}
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
