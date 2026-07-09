import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import InkSpinner from "ink-spinner";
import type { StartEvent, StartStage } from "../../start.js";
import { theme } from "../theme.js";
import { KeyProvider } from "../keys/KeyProvider.js";
import { useKeys, KEY_PRIORITY } from "../keys/useKeys.js";
import { MouseProvider } from "../mouse/MouseProvider.js";
import { AppShell } from "../components/AppShell.js";
import { Panel } from "../components/Panel.js";
import { hint } from "../keys/keymap.js";

export type LaunchBus = {
  events: StartEvent[];
  push: (event: StartEvent) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createLaunchBus(): LaunchBus {
  const events: StartEvent[] = [];
  const listeners = new Set<() => void>();
  return {
    events,
    push(event) {
      events.push(event);
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

const STAGE_LABELS: Array<{ stage: StartStage; label: string }> = [
  { stage: "preflight", label: "Preflight checks" },
  { stage: "resources", label: "Resources" },
  { stage: "worktrees", label: "Worktrees" },
  { stage: "verifier", label: "Verifier" },
  { stage: "warmup", label: "Trust warmup" },
  { stage: "briefs", label: "Briefs & scripts" },
  { stage: "register", label: "Run registry" },
  { stage: "mirrors", label: "Mirrors & scoreboards" },
  { stage: "tmux", label: "tmux session" },
  { stage: "daemon", label: "Mirror daemon" }
];

type StageStatus = "pending" | "active" | "done" | "failed";

function stageStatuses(events: StartEvent[], failed: boolean): Map<StartStage, { status: StageStatus; detail?: string }> {
  const map = new Map<StartStage, { status: StageStatus; detail?: string }>();
  for (const { stage } of STAGE_LABELS) {
    map.set(stage, { status: "pending" });
  }
  for (const event of events) {
    if (event.type !== "stage") {
      continue;
    }
    const current = map.get(event.stage);
    if (event.status === "start") {
      map.set(event.stage, { status: "active", detail: event.detail ?? current?.detail });
    } else {
      map.set(event.stage, { status: "done", detail: event.detail ?? current?.detail });
    }
  }
  if (failed) {
    for (const [stage, value] of map) {
      if (value.status === "active") {
        map.set(stage, { ...value, status: "failed" });
      }
    }
  }
  return map;
}

function StageRow({ label, status, detail }: { label: string; status: StageStatus; detail?: string }): React.ReactElement {
  const marker =
    status === "done" ? (
      <Text color={theme.success}>[x]</Text>
    ) : status === "active" ? (
      <Text color={theme.active}>
        [<InkSpinner type="dots" />]
      </Text>
    ) : status === "failed" ? (
      <Text color={theme.error}>[!]</Text>
    ) : (
      <Text color={theme.dim}>[ ]</Text>
    );

  return (
    <Text>
      {marker}
      <Text color={status === "pending" ? theme.dim : undefined}> {label.padEnd(24)}</Text>
      {detail ? <Text color={theme.dim}>{detail}</Text> : null}
    </Text>
  );
}

export function LaunchProgressApp({
  bus,
  runLabel,
  failure,
  onSkipWarmup
}: {
  bus: LaunchBus;
  runLabel: string;
  failure?: string;
  onSkipWarmup?: () => void;
}): React.ReactElement {
  return (
    <KeyProvider>
      <MouseProvider>
        <LaunchProgressRoot bus={bus} runLabel={runLabel} failure={failure} onSkipWarmup={onSkipWarmup} />
      </MouseProvider>
    </KeyProvider>
  );
}

function LaunchProgressRoot({
  bus,
  runLabel,
  failure,
  onSkipWarmup
}: {
  bus: LaunchBus;
  runLabel: string;
  failure?: string;
  onSkipWarmup?: () => void;
}): React.ReactElement {
  const { exit } = useApp();
  const [, setVersion] = useState(0);

  useEffect(() => bus.subscribe(() => setVersion((current) => current + 1)), [bus]);

  const stages = stageStatuses(bus.events, Boolean(failure));
  const warmupActive = stages.get("warmup")?.status === "active";
  const warnings = bus.events.flatMap((event) => (event.type === "warning" ? [event.message] : []));

  useKeys(
    (input, key) => {
      if (failure && (input === "q" || key.return || key.escape || (key.ctrl && input === "c"))) {
        exit();
        return true;
      }
      if (warmupActive && input === "s" && onSkipWarmup) {
        onSkipWarmup();
        return true;
      }
      return true; // Swallow all other input while launching.
    },
    { priority: KEY_PRIORITY.global }
  );

  return (
    <AppShell
      title={`Starting ${runLabel}`}
      status={failure ? { text: failure, tone: "error" } : undefined}
      hints={
        failure
          ? [hint("q", "Quit")]
          : warmupActive && onSkipWarmup
            ? [hint("s", "Skip warmup wait (I already trusted these CLIs)")]
            : [hint("…", "Starting — overseer opens automatically when ready")]
      }
    >
      <Panel title="Launch" flexGrow={1}>
        {STAGE_LABELS.map(({ stage, label }) => {
          const value = stages.get(stage)!;
          return <StageRow key={stage} label={label} status={value.status} detail={value.detail} />;
        })}
        {warnings.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.warning}>Warnings ({warnings.length}):</Text>
            {warnings.slice(-8).map((warning, index) => (
              <Text key={`${index}-${warning.slice(0, 20)}`} color={theme.warning} wrap="truncate">
                - {warning}
              </Text>
            ))}
          </Box>
        ) : null}
        {failure ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.error} wrap="wrap">
              Start failed: {failure}
            </Text>
            <Text color={theme.dim}>Press q to quit.</Text>
          </Box>
        ) : null}
      </Panel>
    </AppShell>
  );
}
