import path from "node:path";
import React, { useMemo, useRef, useState } from "react";
import { Box, Text, type DOMElement } from "ink";
import { readSecretsEnv, type ResourceAvailabilityContext } from "../../resources.js";
import { selectSetupHelper } from "../../setup.js";
import { configFromDraft, draftWarnings, reviewJson, selectedAgentPresets } from "../../tui-model.js";
import type { ArenaConfig } from "../../types.js";
import { pluralize } from "../../format.js";
import { theme } from "../theme.js";
import { hint } from "../keys/keymap.js";
import { useKeys } from "../keys/useKeys.js";
import { useMouseRegion } from "../mouse/useMouseRegion.js";
import { AppShell } from "../components/AppShell.js";
import { Panel } from "../components/Panel.js";
import { SelectList, type SelectListItem } from "../components/SelectList.js";
import { useModal } from "../components/ModalProvider.js";
import { openTextPrompt } from "../components/prompts.js";
import { useTerminalSize } from "../components/useTerminalSize.js";
import { useWizard } from "../app.js";
import { reviewSections, type ReviewLine } from "../view-models/review-vm.js";

type ActionValue = "start" | "teams" | "task" | "feedback" | "rerun" | "json";

function lineColor(line: ReviewLine): string | undefined {
  if (line.tone === "title") {
    return theme.title;
  }
  if (line.tone === "dim") {
    return theme.dim;
  }
  if (line.tone === "warning") {
    return theme.warning;
  }
  return undefined;
}

export function ReviewScreen(): React.ReactElement {
  const { state, dispatch, toast, showToast, requestExit } = useWizard();
  const modal = useModal();
  const { rows, columns } = useTerminalSize();
  const draft = state.draft;
  const [view, setView] = useState<"contract" | "json">("contract");
  const [scroll, setScroll] = useState(0);
  const [action, setAction] = useState<ActionValue>("start");
  const contractRef = useRef<DOMElement | null>(null);

  const helper = useMemo(() => selectSetupHelper(selectedAgentPresets(draft)), [draft.agents]);

  const built = useMemo<{ config?: ArenaConfig; error?: string }>(() => {
    try {
      return { config: configFromDraft(draft) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, [draft]);

  const resourceContext = useMemo<ResourceAvailabilityContext>(() => {
    if (!state.repoRoot) {
      return {};
    }
    return {
      savedSecrets: readSecretsEnv(path.join(state.repoRoot, ".agent-arena")),
      baseDir: state.repoRoot
    };
  }, [state.repoRoot]);

  const warnings = useMemo(() => draftWarnings(draft, resourceContext), [draft, resourceContext]);

  // Soft-wrap long contract lines to the panel width before the vertical
  // slice, so nothing is silently `…`-truncated and paging stays line-based.
  const contractWidth = Math.max(24, Math.floor(columns * 0.66) - 6);
  const lines = useMemo<ReviewLine[]>(() => {
    const wrap = (line: ReviewLine): ReviewLine[] => {
      if (line.text.length <= contractWidth) {
        return [line];
      }
      const wrapped: ReviewLine[] = [];
      const indent = `${line.text.match(/^\s*/)?.[0] ?? ""}  `;
      let rest = line.text;
      let first = true;
      while (rest.length > 0) {
        const budget = first ? contractWidth : contractWidth - indent.length;
        if (rest.length <= budget) {
          wrapped.push({ ...line, text: first ? rest : indent + rest });
          break;
        }
        const slice = rest.slice(0, budget);
        const breakAt = slice.lastIndexOf(" ") > budget * 0.6 ? slice.lastIndexOf(" ") : budget;
        wrapped.push({ ...line, text: first ? slice.slice(0, breakAt) : indent + slice.slice(0, breakAt) });
        rest = rest.slice(breakAt).replace(/^ +/, "");
        first = false;
      }
      return wrapped;
    };
    const raw: ReviewLine[] = !built.config
      ? [{ text: built.error ?? "Draft is not valid yet.", tone: "warning" }]
      : view === "json"
        ? reviewJson(built.config)
            .split("\n")
            .map((text) => ({ text }))
        : reviewSections(built.config, warnings, resourceContext);
    return raw.flatMap(wrap);
  }, [built, view, warnings, resourceContext, contractWidth]);

  const bodyHeight = Math.max(8, rows - 9);
  const maxScroll = Math.max(0, lines.length - bodyHeight);
  const clampedScroll = Math.min(scroll, maxScroll);
  const visible = lines.slice(clampedScroll, clampedScroll + bodyHeight);

  const actions: Array<SelectListItem<ActionValue>> = [
    {
      value: "start",
      label: "Start arena",
      disabled: !built.config || !state.repoRoot,
      disabledReason: !state.repoRoot ? "Select a project first." : built.error
    },
    { value: "teams", label: "Edit teams" },
    { value: "task", label: "Edit task" },
    {
      value: "feedback",
      label: "Send feedback to helper…",
      disabled: !helper || !state.helperRan,
      disabledReason: !helper
        ? "No selected agent CLI is installed to act as setup helper."
        : "No helper has run yet — use Run helper first."
    },
    {
      value: "rerun",
      label: state.helperRan ? "Rerun helper" : "Run helper",
      disabled: !helper,
      disabledReason: "No selected agent CLI is installed to act as setup helper."
    },
    { value: "json", label: view === "contract" ? "View JSON" : "View contract" }
  ];

  function startArenaAction(): void {
    if (!built.config || !state.repoRoot) {
      return;
    }
    const config = built.config;
    const repoRoot = state.repoRoot;
    void modal
      .confirm({
        title: "Start the arena?",
        message: `Writes arena.config.json to ${repoRoot} and starts the run: git worktrees and a tmux session will be created for ${config.agents.length} agents.`,
        confirmLabel: "Start",
        cancelLabel: "Not yet"
      })
      .then((confirmed) => {
        if (confirmed) {
          requestExit({ kind: "start", repoRoot, config });
        }
      });
  }

  function activate(value: ActionValue): void {
    if (value === "start") {
      startArenaAction();
    } else if (value === "teams") {
      dispatch({ type: "replaceStack", stack: [{ name: "project" }, { name: "teams" }] });
    } else if (value === "task") {
      dispatch({ type: "replaceStack", stack: [{ name: "project" }, { name: "teams" }, { name: "task" }] });
    } else if (value === "feedback") {
      void openTextPrompt(modal, {
        title: "Feedback for the setup helper",
        label: "What should change in the draft?",
        placeholder: "e.g. make the verifier stricter, focus on the benchmark",
        width: 70
      }).then((feedback) => {
        if (feedback?.trim() && helper && state.repoRoot) {
          requestExit({ kind: "helper", repoRoot: state.repoRoot, draft, helper, feedback: feedback.trim() });
        }
      });
    } else if (value === "rerun") {
      if (helper && state.repoRoot) {
        requestExit({ kind: "helper", repoRoot: state.repoRoot, draft, helper });
      }
    } else if (value === "json") {
      setView((current) => (current === "contract" ? "json" : "contract"));
      setScroll(0);
    }
  }

  useKeys((input, key) => {
    if (key.leftArrow) {
      dispatch({ type: "pop" });
      return true;
    }
    if (key.pageUp) {
      setScroll((current) => Math.max(0, current - 10));
      return true;
    }
    if (key.pageDown) {
      setScroll((current) => Math.min(maxScroll, current + 10));
      return true;
    }
    if (input === "v") {
      setView((current) => (current === "contract" ? "json" : "contract"));
      setScroll(0);
      return true;
    }
    return false;
  });

  useMouseRegion(contractRef, {
    onWheel: ({ direction }) => {
      setScroll((current) =>
        direction === "up" ? Math.max(0, current - 3) : Math.min(maxScroll, current + 3)
      );
    }
  });

  const scrollLabel = lines.length > bodyHeight ? ` (${clampedScroll + 1}-${Math.min(lines.length, clampedScroll + bodyHeight)}/${lines.length})` : "";

  return (
    <AppShell
      title="Setup — Review & Start"
      step={{ index: 4, total: 4 }}
      status={toast ?? (state.notices.length > 0 ? { text: state.notices[0], tone: "warn" } : undefined)}
      onDisabledHint={(reason) => showToast(reason, "warn")}
      hints={[
        hint("↑↓", "Move"),
        hint("Enter", "Select", { onPress: () => activate(action) }),
        hint("v", "JSON", { onPress: () => activate("json") }),
        hint("PgUp/PgDn", "Scroll"),
        hint("←", "Back", { onPress: () => dispatch({ type: "pop" }) }),
        hint("Esc", "Back")
      ]}
    >
      <Box flexGrow={1}>
        <Box width="68%" flexDirection="column" ref={contractRef}>
          <Panel title={`Draft contract${view === "json" ? " — JSON" : ""}${scrollLabel}`} flexGrow={1}>
            {visible.map((line, index) => (
              <Text key={`${clampedScroll + index}`} color={lineColor(line)} wrap="truncate">
                {line.text || " "}
              </Text>
            ))}
          </Panel>
        </Box>
        <Box width="32%" flexDirection="column">
          <Panel title="Actions" flexGrow={1}>
            <SelectList
              items={actions}
              selected={action}
              onSelect={setAction}
              onActivate={activate}
              height={actions.length}
              onDisabledActivate={(reason) => showToast(reason, "warn")}
              // The actions list is short and fully visible; let PgUp/PgDn
              // fall through to the contract-panel scroll handler.
              pageKeys={false}
            />
            <Text> </Text>
            {warnings.length > 0 ? (
              <Box flexDirection="column">
                {/* Warnings listed here directly — previously only a count
                    pointing into the (scrollable) contract text. */}
                <Text color={theme.warning}>{pluralize(warnings.length, "warning")}:</Text>
                {warnings.slice(0, 6).map((warning) => (
                  <Text key={warning} color={theme.warning} wrap="wrap">
                    - {warning}
                  </Text>
                ))}
                {warnings.length > 6 ? <Text color={theme.dim}>…and {warnings.length - 6} more.</Text> : null}
              </Box>
            ) : (
              <Text color={theme.success}>No warnings.</Text>
            )}
          </Panel>
        </Box>
      </Box>
    </AppShell>
  );
}
