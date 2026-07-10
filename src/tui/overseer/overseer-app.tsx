import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp } from "ink";
import { tmuxAttachCommand, type TerminalAttachMode } from "../../terminal.js";
import { attachTmux, openAgentPaneExternal } from "../../tmux.js";
import { pluralize } from "../../format.js";
import { glyphs, theme } from "../theme.js";
import { KeyProvider } from "../keys/KeyProvider.js";
import { useKeys, KEY_PRIORITY } from "../keys/useKeys.js";
import { hint, type KeyHint } from "../keys/keymap.js";
import { MouseProvider } from "../mouse/MouseProvider.js";
import { Clickable } from "../mouse/Clickable.js";
import { AppShell } from "../components/AppShell.js";
import { ModalProvider, useModal } from "../components/ModalProvider.js";
import { Panel } from "../components/Panel.js";
import { Spinner } from "../components/Spinner.js";
import { useToast } from "../components/useToast.js";
import { LayerContext } from "../layers.js";
import { agentDisplayName, elapsedLabel, pendingClaims, buildThreads } from "./model.js";
import type { OverseerActions } from "./actions.js";
import type { RunSnapshot, RunWatcher } from "./run-watcher.js";
import { DashboardView } from "./dashboard.js";
import { ChatView } from "./chat-view.js";
import { ProposalsView } from "./proposals-view.js";
import { JudgeView } from "./judge-view.js";

export type OverseerView = "dashboard" | "chat" | "proposals" | "judge";

export type OverseerContextValue = {
  snapshot: RunSnapshot;
  actions: OverseerActions;
  readOnly: boolean;
  showToast: (text: string, tone?: "info" | "warn" | "error") => void;
  runAction: <T>(
    label: string,
    action: () => Promise<T>,
    options?: { allowWhenFinished?: boolean }
  ) => Promise<T | undefined>;
  openChat: (threadId?: string) => void;
  openJudge: (agentId?: string) => void;
  openAgentPane: (agentId: string) => void;
  offerHarvest: (winnerAgentId: string) => void;
  chatThreadId?: string;
  judgeAgentId?: string;
};

const OverseerContext = createContext<OverseerContextValue | undefined>(undefined);

export function useOverseer(): OverseerContextValue {
  const value = useContext(OverseerContext);
  if (!value) {
    throw new Error("useOverseer must be used inside OverseerApp.");
  }
  return value;
}

function BusyOverlay({ label }: { label: string }): React.ReactElement {
  useKeys(() => true, { priority: KEY_PRIORITY.field });
  return (
    <Box position="absolute" marginTop={10} width="100%" justifyContent="center">
      <Panel tone="accent">
        <Spinner label={label} />
      </Panel>
    </Box>
  );
}

const VIEWS: Array<{ id: OverseerView; key: string; label: string }> = [
  { id: "dashboard", key: "1", label: "Dashboard" },
  { id: "chat", key: "2", label: "Chat" },
  { id: "proposals", key: "3", label: "Proposals" },
  { id: "judge", key: "4", label: "Judge" }
];

function statusBadge(snapshot: RunSnapshot): React.ReactElement {
  if (snapshot.state.status === "finished") {
    return <Text color={theme.success}>FINISHED</Text>;
  }
  if (snapshot.state.status === "stopped") {
    return <Text color={theme.warning}>STOPPED</Text>;
  }
  return <Text color={theme.active}>RUNNING {elapsedLabel(snapshot)}</Text>;
}

function OverseerRoot({
  watcher,
  actions,
  initialSnapshot,
  terminal
}: {
  watcher: RunWatcher;
  actions: OverseerActions;
  initialSnapshot: RunSnapshot;
  terminal: TerminalAttachMode;
}): React.ReactElement {
  const { exit } = useApp();
  const modal = useModal();
  const { toast, showToast } = useToast();
  const [snapshot, setSnapshot] = useState<RunSnapshot>(initialSnapshot);
  const [view, setView] = useState<OverseerView>("dashboard");
  const [busy, setBusy] = useState<string | undefined>();
  const [chatThreadId, setChatThreadId] = useState<string | undefined>();
  const [judgeAgentId, setJudgeAgentId] = useState<string | undefined>();
  const [announcedFinish, setAnnouncedFinish] = useState(initialSnapshot.state.status === "finished");
  // Last failed harvest attempt, kept until a harvest succeeds so the WINNER
  // banner can explain the failure durably (a toast alone fades in 2.5s).
  const [harvestError, setHarvestError] = useState<string | undefined>();

  useEffect(() => watcher.subscribe(setSnapshot), [watcher]);

  useEffect(() => {
    if (snapshot.state.status === "finished" && !announcedFinish) {
      setAnnouncedFinish(true);
      showToast(
        `Run finished — winner ${snapshot.state.winner ? agentDisplayName(snapshot, snapshot.state.winner.agentId) : "unknown"}. Mutating actions disabled.`,
        "info"
      );
    }
  }, [snapshot.state.status, announcedFinish, showToast, snapshot.state.winner?.agentId]);

  const readOnly = snapshot.state.status !== "running";
  const pending = pendingClaims(snapshot);
  const threads = useMemo(() => buildThreads(snapshot), [snapshot]);
  const totalUnread = threads.reduce((total, thread) => total + thread.unread, 0);

  async function runAction<T>(
    label: string,
    action: () => Promise<T>,
    options?: { allowWhenFinished?: boolean }
  ): Promise<T | undefined> {
    if (readOnly && !options?.allowWhenFinished) {
      showToast("Run is finished; actions are disabled.", "warn");
      return undefined;
    }
    setBusy(label);
    try {
      return await action();
    } catch (error) {
      showToast((error as Error).message, "error");
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }

  // Central harvest entry point (judge accept flow and the `h` retry key both
  // land here) so failures are captured into harvestError, not just a toast.
  function offerHarvest(winnerAgentId: string): void {
    void modal
      .confirm({
        title: "Harvest the winner's work?",
        message: `Commits ${agentDisplayName(snapshot, winnerAgentId)}'s work to its arena branch and merges it into the checked-out branch of the base repo. You can also do this later with: arena harvest --run ${snapshot.state.runId}`,
        confirmLabel: "Harvest & merge",
        cancelLabel: "Later",
        // Merging into the base repo is hard to undo; default to the safe side.
        defaultButton: "cancel"
      })
      .then((confirmed) => {
        if (!confirmed) {
          return;
        }
        void (async () => {
          // The run is already finished by the accept, so harvesting must be
          // allowed to run on a finished run (hence not runAction's guard).
          setBusy("Harvesting winner's work…");
          try {
            const result = await actions.harvestWinner();
            setHarvestError(undefined);
            showToast(result.messages[result.messages.length - 1] ?? "Harvested.", "info");
          } catch (error) {
            const reason = (error as Error).message;
            setHarvestError(reason);
            showToast(`Harvest failed: ${reason}`, "error");
          } finally {
            setBusy(undefined);
          }
        })();
      });
  }

  function openAgentPane(agentId: string): void {
    const result = openAgentPaneExternal(snapshot.state, agentId);
    if (result.error) {
      showToast(result.error, "error");
      return;
    }
    if (!result.launchedExternal && !result.attached && !result.openedInTmux) {
      void modal.confirm({
        title: "Peek at the agent",
        message: `Run this in another terminal to watch the agent live:\n\n${result.command}\n\nClose the peek anytime with Alt-q (or Ctrl-b d) — the run keeps going.\n\n${result.warnings.join("\n")}`,
        confirmLabel: "OK",
        cancelLabel: "Close"
      });
      return;
    }
    const agent = snapshot.state.agents.find((candidate) => candidate.id === agentId);
    showToast(
      `Peeking at ${agent?.codename ?? agentId} — press Alt-q (or Ctrl-b d) to close it; the run keeps going.`,
      "info"
    );
  }

  function openTmux(): void {
    if (!snapshot.tmuxAlive) {
      showToast("The tmux session for this run is gone.", "error");
      return;
    }
    // The overseer owns this terminal, so the session opens elsewhere: a tmux
    // split when we are inside tmux, otherwise an external terminal app.
    const result = attachTmux(snapshot.state.tmux.sessionName, "external");
    if (!result.launchedExternal && !result.attached && !result.openedInTmux) {
      const command = tmuxAttachCommand(snapshot.state.tmux.sessionName);
      void modal.confirm({
        title: "Attach manually",
        message: `Could not open a terminal automatically. Run this in another terminal:\n\n${command}\n\n${result.warnings.join("\n")}`,
        confirmLabel: "OK",
        cancelLabel: "Close"
      });
    } else {
      showToast(
        result.openedInTmux
          ? "Opened the agent tmux session in a split next to this one."
          : "Opened the agent tmux session in an external terminal.",
        "info"
      );
    }
  }

  function sendPressureAction(): void {
    void modal
      .confirm({
        title: "Send pressure notice",
        message: "Send a competitive pressure notice to all agents? This nudges every agent pane.",
        confirmLabel: "Send"
      })
      .then((confirmed) => {
        if (confirmed) {
          void runAction("Sending pressure notice…", () => actions.sendPressure({})).then((count) => {
            if (count !== undefined) {
              showToast(`Sent pressure notice to ${pluralize(count, "agent")}.`, "info");
            }
          });
        }
      });
  }

  function restartDaemonAction(): void {
    void modal
      .confirm({
        title: "Restart mirror daemon",
        message: "The mirror daemon keeps rival mirrors and scoreboards fresh. Restart it?",
        confirmLabel: "Restart"
      })
      .then((confirmed) => {
        if (confirmed) {
          void runAction("Restarting mirror daemon…", () => actions.restartDaemon()).then((pid) => {
            if (pid !== undefined) {
              showToast(`Mirror daemon restarted (pid ${pid}).`, "info");
            }
          });
        }
      });
  }

  useKeys(
    (input, key) => {
      const viewByKey = VIEWS.find((candidate) => candidate.key === input);
      if (viewByKey) {
        setView(viewByKey.id);
        return true;
      }
      if (key.tab) {
        const index = VIEWS.findIndex((candidate) => candidate.id === view);
        const next = key.shift ? (index + VIEWS.length - 1) % VIEWS.length : (index + 1) % VIEWS.length;
        setView(VIEWS[next].id);
        return true;
      }
      if (input === "o" || input === "O") {
        openTmux();
        return true;
      }
      if (input === "p" && !readOnly) {
        sendPressureAction();
        return true;
      }
      if (input === "r") {
        void watcher.refreshNow().then(() => showToast("Refreshed.", "info"));
        return true;
      }
      if (input === "R" && !snapshot.daemonAlive && !readOnly) {
        restartDaemonAction();
        return true;
      }
      if (input === "h" && snapshot.state.status === "finished" && snapshot.state.winner && !snapshot.state.harvest) {
        offerHarvest(snapshot.state.winner.agentId);
        return true;
      }
      if (input === "q" || (key.ctrl && input === "c")) {
        exit();
        return true;
      }
      // Same rule as the wizard: Esc goes one level back, and quits at the root.
      // View-level Esc handlers (chat input, proposal detail) run first.
      if (key.escape) {
        if (view !== "dashboard") {
          setView("dashboard");
        } else {
          exit();
        }
        return true;
      }
      return false;
    },
    { priority: KEY_PRIORITY.global }
  );

  const value = useMemo<OverseerContextValue>(
    () => ({
      snapshot,
      actions,
      readOnly,
      showToast,
      runAction,
      openChat: (threadId) => {
        if (threadId) {
          setChatThreadId(threadId);
        }
        setView("chat");
      },
      openJudge: (agentId) => {
        if (agentId) {
          setJudgeAgentId(agentId);
        }
        setView("judge");
      },
      openAgentPane,
      offerHarvest,
      chatThreadId,
      judgeAgentId
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, actions, readOnly, showToast, chatThreadId, judgeAgentId]
  );

  const hints: KeyHint[] = [
    hint("1-4", "Views"),
    ...(view === "dashboard"
      ? [hint("o", "Peek agent"), hint("O", "Peek all tmux", { onPress: openTmux })]
      : [hint("o", "Peek tmux", { onPress: openTmux })]),
    hint("p", "Pressure", {
      onPress: sendPressureAction,
      disabled: readOnly,
      disabledReason: "Run is finished."
    }),
    hint("r", "Refresh", { onPress: () => void watcher.refreshNow() }),
    ...(!snapshot.daemonAlive && !readOnly
      ? [hint("R", "Restart daemon", { onPress: restartDaemonAction })]
      : []),
    ...(snapshot.state.status === "finished" && snapshot.state.winner && !snapshot.state.harvest
      ? [
          hint("h", "Harvest", {
            onPress: () => {
              if (snapshot.state.winner) {
                offerHarvest(snapshot.state.winner.agentId);
              }
            }
          })
        ]
      : []),
    hint("q", "Quit (run continues)", { onPress: () => exit() })
  ];

  const viewBadge = (candidate: (typeof VIEWS)[number]): string => {
    if (candidate.id === "chat" && totalUnread > 0) {
      return ` (${totalUnread})`;
    }
    if (candidate.id === "proposals") {
      const open = snapshot.proposals.filter((proposal) => proposal.status === "pending").length;
      return open > 0 ? ` (${open})` : "";
    }
    if (candidate.id === "judge" && pending.length > 0) {
      return ` (${pending.length}!)`;
    }
    return "";
  };

  return (
    <OverseerContext.Provider value={value}>
      <AppShell
        title={`Overseer — run ${snapshot.state.runId}`}
        status={toast}
        onDisabledHint={(reason) => showToast(reason, "warn")}
        hints={hints}
      >
        <Box flexShrink={0} gap={2}>
          {statusBadge(snapshot)}
          <Text color={theme.dim}>judging: {snapshot.state.judging.mode}</Text>
          {/* The mirror daemon legitimately exits when a run ends, so only
              running runs show its health (and the R-restart hint). */}
          {readOnly ? null : (
            <Text color={snapshot.daemonAlive ? theme.dim : theme.error}>
              daemon: {snapshot.daemonAlive ? "ok" : "DEAD (R restarts)"}
            </Text>
          )}
          <Text color={snapshot.tmuxAlive ? theme.dim : theme.error}>tmux: {snapshot.tmuxAlive ? "ok" : "GONE"}</Text>
        </Box>
        <Box flexShrink={0} gap={1}>
          {VIEWS.map((candidate) => (
            <Clickable key={candidate.id} onPress={() => setView(candidate.id)}>
              <Text
                backgroundColor={view === candidate.id ? theme.selectionBg : undefined}
                color={view === candidate.id ? theme.selectionFg : theme.dim}
              >
                {` ${candidate.key} ${candidate.label}${viewBadge(candidate)} `}
              </Text>
            </Clickable>
          ))}
        </Box>
        {snapshot.state.status === "finished" && snapshot.state.winner ? (
          <Box flexShrink={0}>
            <Text color={theme.success} wrap="truncate">
              {glyphs.captain} WINNER: {agentDisplayName(snapshot, snapshot.state.winner.agentId)} —{" "}
              {snapshot.state.harvest
                ? snapshot.state.harvest.merged
                  ? `harvested into ${snapshot.state.harvest.targetBranch}`
                  : `harvested to branch ${snapshot.state.harvest.branch} (not merged)`
                : harvestError
                  ? `harvest FAILED: ${harvestError} — press h to retry`
                  : `not harvested — press h (or: arena harvest --run ${snapshot.state.runId})`}
            </Text>
          </Box>
        ) : pending.length > 0 ? (
          <Clickable onPress={() => setView("judge")}>
            <Text color={theme.warning}>
              ! {pending.map((claim) => agentDisplayName(snapshot, claim.agentId)).join(", ")} claim{pending.length === 1 ? "s" : ""} finish — press
              4 to judge
            </Text>
          </Clickable>
        ) : (
          <Box flexShrink={0} height={1} />
        )}
        <Box flexGrow={1} flexDirection="column">
          {view === "dashboard" ? <DashboardView /> : null}
          {view === "chat" ? <ChatView /> : null}
          {view === "proposals" ? <ProposalsView /> : null}
          {view === "judge" ? <JudgeView /> : null}
        </Box>
        {busy ? (
          <LayerContext.Provider value={1000}>
            <BusyOverlay label={busy} />
          </LayerContext.Provider>
        ) : null}
      </AppShell>
    </OverseerContext.Provider>
  );
}

export function OverseerApp({
  watcher,
  actions,
  initialSnapshot,
  terminal = "auto"
}: {
  watcher: RunWatcher;
  actions: OverseerActions;
  initialSnapshot: RunSnapshot;
  terminal?: TerminalAttachMode;
}): React.ReactElement {
  return (
    <KeyProvider>
      <MouseProvider>
        <ModalProvider>
          <OverseerRoot watcher={watcher} actions={actions} initialSnapshot={initialSnapshot} terminal={terminal} />
        </ModalProvider>
      </MouseProvider>
    </KeyProvider>
  );
}
