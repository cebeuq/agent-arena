import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readChatMessages, readChatReadState, type ChatMessage } from "../../chat.js";
import { collectAgentProgressAsync, type AgentProgress } from "../../competition.js";
import { readProposalRecords, type ProposalRecord } from "../../proposals.js";
import { readRunState } from "../../run-state.js";
import type { RunState } from "../../types.js";

export type RunSnapshot = {
  state: RunState;
  messages: ChatMessage[];
  reads: Record<string, string[]>;
  proposals: ProposalRecord[];
  progress: AgentProgress[];
  progressUpdatedAt?: string;
  daemonAlive: boolean;
  tmuxAlive: boolean;
  updatedAt: string;
};

export type RunWatcherOptions = {
  statePath: string;
  stateIntervalMs?: number;
  progressIntervalMs?: number;
  collectProgress?: (state: RunState) => Promise<AgentProgress[]>;
  probeDaemon?: (pid: number | undefined) => boolean;
  probeTmux?: (sessionName: string) => boolean;
};

export type RunWatcher = {
  current(): RunSnapshot | undefined;
  subscribe(listener: (snapshot: RunSnapshot) => void): () => void;
  refreshNow(): Promise<void>;
  stop(): void;
};

export function defaultProbeDaemon(pid: number | undefined): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
}

export function defaultProbeTmux(sessionName: string): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" });
  return result.status === 0;
}

function changeKey(snapshot: RunSnapshot): string {
  return JSON.stringify({
    state: snapshot.state,
    messages: snapshot.messages.length,
    lastMessage: snapshot.messages[snapshot.messages.length - 1]?.id,
    reads: snapshot.reads,
    proposals: snapshot.proposals,
    progressUpdatedAt: snapshot.progressUpdatedAt,
    daemonAlive: snapshot.daemonAlive,
    tmuxAlive: snapshot.tmuxAlive
  });
}

export function createRunWatcher(options: RunWatcherOptions): RunWatcher {
  const stateIntervalMs = options.stateIntervalMs ?? 1000;
  const progressIntervalMs = options.progressIntervalMs ?? 5000;
  const collectProgress = options.collectProgress ?? collectAgentProgressAsync;
  const probeDaemon = options.probeDaemon ?? defaultProbeDaemon;
  const probeTmux = options.probeTmux ?? defaultProbeTmux;

  const listeners = new Set<(snapshot: RunSnapshot) => void>();
  let snapshot: RunSnapshot | undefined;
  let lastChangeKey = "";
  let lastProgress: AgentProgress[] = [];
  let lastProgressAt = 0;
  let progressUpdatedAt: string | undefined;
  let inflight: Promise<void> | undefined;
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const fsWatchers: fs.FSWatcher[] = [];

  // Periodic ticks join an in-flight refresh instead of stacking; refreshNow()
  // additionally awaits the in-flight one and then runs its own forced pass so
  // callers always observe a snapshot taken after they were called.
  function refresh(forceProgress = false): Promise<void> {
    if (stopped) {
      return Promise.resolve();
    }
    if (inflight) {
      return inflight;
    }
    inflight = doRefresh(forceProgress).finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  async function doRefresh(forceProgress: boolean): Promise<void> {
    try {
      const state = await readRunState(options.statePath);
      const [messages, reads, proposals] = await Promise.all([
        readChatMessages(state),
        readChatReadState(state),
        readProposalRecords(state)
      ]);

      const now = Date.now();
      const wantProgress =
        forceProgress || lastProgressAt === 0 || (state.status === "running" && now - lastProgressAt >= progressIntervalMs);
      if (wantProgress) {
        lastProgress = await collectProgress(state);
        lastProgressAt = now;
        progressUpdatedAt = new Date(now).toISOString();
      }

      const next: RunSnapshot = {
        state,
        messages,
        reads,
        proposals,
        progress: lastProgress,
        progressUpdatedAt,
        daemonAlive: probeDaemon(state.mirrorDaemonPid),
        tmuxAlive: probeTmux(state.tmux.sessionName),
        updatedAt: new Date().toISOString()
      };

      const key = changeKey(next);
      if (key !== lastChangeKey) {
        lastChangeKey = key;
        snapshot = next;
        for (const listener of listeners) {
          listener(next);
        }
      } else {
        snapshot = next;
      }
    } catch {
      // Keep the last good snapshot; transient read/parse failures heal next tick.
    }
  }

  function scheduleEarlyRefresh(): void {
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => {
      void refresh();
    }, 150);
  }

  function armWatchers(): void {
    const runDir = path.dirname(options.statePath);
    for (const target of [runDir, path.join(runDir, "chat"), path.join(runDir, "proposals")]) {
      try {
        const watcher = fs.watch(target, scheduleEarlyRefresh);
        watcher.on("error", () => {
          watcher.close();
        });
        fsWatchers.push(watcher);
      } catch {
        // Directory may not exist yet; the interval poll covers it.
      }
    }
  }

  void refresh(true);
  interval = setInterval(() => {
    void refresh();
  }, stateIntervalMs);
  armWatchers();

  return {
    current: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      if (snapshot) {
        listener(snapshot);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    async refreshNow() {
      if (inflight) {
        await inflight;
      }
      await refresh(true);
    },
    stop() {
      stopped = true;
      if (interval) {
        clearInterval(interval);
      }
      if (debounce) {
        clearTimeout(debounce);
      }
      for (const watcher of fsWatchers) {
        watcher.close();
      }
      listeners.clear();
    }
  };
}
