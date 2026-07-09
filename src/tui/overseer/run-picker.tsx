import React, { useState } from "react";
import { Text, useApp } from "ink";
import type { LocalRunState } from "../../run-state.js";
import { theme } from "../theme.js";
import { hint } from "../keys/keymap.js";
import { useKeys, KEY_PRIORITY } from "../keys/useKeys.js";
import { KeyProvider } from "../keys/KeyProvider.js";
import { MouseProvider } from "../mouse/MouseProvider.js";
import { ModalProvider } from "../components/ModalProvider.js";
import { AppShell } from "../components/AppShell.js";
import { Panel } from "../components/Panel.js";
import { SelectList, type SelectListItem } from "../components/SelectList.js";

function runLabel(entry: LocalRunState): string {
  const status = entry.state.status === "running" ? "RUNNING" : entry.state.status;
  return `${entry.state.runId}  [${status}]  ${entry.state.goal.slice(0, 50)}`;
}

function PickerRoot({
  runs,
  onPick
}: {
  runs: LocalRunState[];
  onPick: (statePath: string | undefined) => void;
}): React.ReactElement {
  const { exit } = useApp();
  const [selected, setSelected] = useState<string | undefined>(runs[0]?.statePath);

  useKeys(
    (input, key) => {
      if (key.escape || input === "q") {
        onPick(undefined);
        exit();
        return true;
      }
      return false;
    },
    { priority: KEY_PRIORITY.global }
  );

  const items: Array<SelectListItem<string>> = runs.map((entry) => ({
    value: entry.statePath,
    label: runLabel(entry),
    detail: entry.state.startedAt.slice(0, 16)
  }));

  return (
    <AppShell
      title="Overseer — pick a run"
      hints={[hint("↑↓", "Move"), hint("Enter", "Open"), hint("q/Esc", "Quit")]}
    >
      <Panel title="Local runs" flexGrow={1}>
        <SelectList
          items={items}
          selected={selected}
          onSelect={setSelected}
          onActivate={(value) => {
            onPick(value);
            exit();
          }}
          height={Math.max(4, items.length)}
        />
        <Text color={theme.dim}>Running runs are listed first.</Text>
      </Panel>
    </AppShell>
  );
}

export function RunPickerApp({
  runs,
  onPick
}: {
  runs: LocalRunState[];
  onPick: (statePath: string | undefined) => void;
}): React.ReactElement {
  return (
    <KeyProvider>
      <MouseProvider>
        <ModalProvider>
          <PickerRoot runs={runs} onPick={onPick} />
        </ModalProvider>
      </MouseProvider>
    </KeyProvider>
  );
}
