import path from "node:path";
import { spawnSync } from "node:child_process";
import React from "react";
import { render, type Instance } from "ink";
import { listLocalRunStates, readRunState, resolveStatePath, type LocalRunState } from "../../run-state.js";
import { startArena } from "../../start.js";
import type { TerminalAttachMode } from "../../terminal.js";
import { runTrustWarmup } from "../../tmux.js";
import type { RunState } from "../../types.js";
import { registerInkClear } from "../components/editor-escape.js";
import { enterTuiScreen, leaveTuiScreen } from "../screen-control.js";
import { createActions } from "./actions.js";
import { createRunWatcher } from "./run-watcher.js";
import { createLaunchBus, LaunchProgressApp } from "./launch-progress.js";
import { OverseerApp } from "./overseer-app.js";
import { RunPickerApp } from "./run-picker.js";

export type OverseerOptions = {
  runId?: string;
  statePath?: string;
  cliPath: string;
  cwd?: string;
  terminal?: TerminalAttachMode;
};

async function pickRun(runs: LocalRunState[]): Promise<string | undefined> {
  let picked: string | undefined;
  enterTuiScreen();
  try {
    const instance = render(
      <RunPickerApp
        runs={runs}
        onPick={(statePath) => {
          picked = statePath;
        }}
      />,
      { exitOnCtrlC: false }
    );
    await instance.waitUntilExit();
  } finally {
    leaveTuiScreen();
  }
  return picked;
}

async function resolveOverseerStatePath(options: OverseerOptions): Promise<string | undefined> {
  if (options.statePath) {
    return path.resolve(options.statePath);
  }
  if (options.runId) {
    return resolveStatePath(options.runId);
  }

  const runs = await listLocalRunStates(options.cwd);
  if (runs.length === 0) {
    throw new Error("No local Agent Arena runs found. Start one with `arena` or pass --run/--state.");
  }
  const running = runs.filter((entry) => entry.state.status === "running");
  if (running.length === 1) {
    return running[0].statePath;
  }
  if (runs.length === 1) {
    return runs[0].statePath;
  }

  const ordered = [
    ...running.sort((left, right) => right.state.startedAt.localeCompare(left.state.startedAt)),
    ...runs
      .filter((entry) => entry.state.status !== "running")
      .sort((left, right) => right.state.startedAt.localeCompare(left.state.startedAt))
  ];
  return pickRun(ordered);
}

// Mounts the overseer for an already-running run. Assumes the alt screen is
// active; the caller owns enter/leaveTuiScreen.
async function mountOverseer(statePath: string, cliPath: string, terminal?: TerminalAttachMode): Promise<void> {
  const state = await readRunState(statePath);
  const watcher = createRunWatcher({ statePath });
  const actions = createActions({
    runId: state.runId,
    statePath,
    cliPath,
    watcher
  });

  // Wait for the first snapshot so the app mounts with data.
  await watcher.refreshNow();
  const initialSnapshot = watcher.current();
  if (!initialSnapshot) {
    watcher.stop();
    throw new Error(`Could not read run state at ${statePath}.`);
  }

  try {
    const instance = render(
      <OverseerApp watcher={watcher} actions={actions} initialSnapshot={initialSnapshot} terminal={terminal} />,
      { exitOnCtrlC: false }
    );
    registerInkClear(() => instance.clear());
    await instance.waitUntilExit();
  } finally {
    registerInkClear(undefined);
    watcher.stop();
  }
}

export async function runOverseer(options: OverseerOptions): Promise<void> {
  const statePath = await resolveOverseerStatePath(options);
  if (!statePath) {
    return; // User cancelled the picker.
  }

  enterTuiScreen();
  try {
    await mountOverseer(statePath, options.cliPath, options.terminal);
  } finally {
    leaveTuiScreen();
  }
}

export type LaunchAndOverseerOptions = {
  configPath: string;
  cliPath: string;
  terminal?: TerminalAttachMode;
};

// Runs startArena behind a launch-progress checklist, then hands the terminal to
// the overseer. tmux is never attached in this terminal; agents open externally.
export async function runLaunchAndOverseer(options: LaunchAndOverseerOptions): Promise<void> {
  const bus = createLaunchBus();
  let instance: Instance | undefined;
  let skipWarmup: (() => void) | undefined;

  const mountLaunch = (failure?: string): void => {
    instance = render(
      <LaunchProgressApp
        bus={bus}
        runLabel={path.dirname(path.resolve(options.configPath))}
        failure={failure}
        onSkipWarmup={() => skipWarmup?.()}
      />,
      { exitOnCtrlC: false }
    );
  };

  enterTuiScreen();
  try {
    mountLaunch();

    let state: RunState | undefined;
    let failure: string | undefined;
    try {
      state = await startArena({
        configPath: options.configPath,
        attach: true,
        terminal: options.terminal,
        cliPath: options.cliPath,
        reporter: (event) => bus.push(event),
        attachWhenDone: false,
        runWarmup: async (warmupState, agentIds) => {
          // Trust warmup needs a real terminal. Try an external window first so
          // the progress screen stays visible; otherwise suspend Ink and use
          // this terminal, then restore the progress screen.
          const trustSession = `${warmupState.tmux.sessionName}-trust`;
          skipWarmup = () => {
            // Killing the trust session unblocks the wait below; the agents will
            // surface any remaining trust/auth prompts in their race panes.
            spawnSync("tmux", ["kill-session", "-t", trustSession], { stdio: "ignore" });
          };
          try {
            await runTrustWarmup(warmupState, "external", undefined, agentIds);
            return;
          } catch {
            // Fall back to taking over this terminal.
          } finally {
            skipWarmup = undefined;
          }
          instance?.unmount();
          leaveTuiScreen();
          try {
            await runTrustWarmup(warmupState, "current", undefined, agentIds);
          } finally {
            enterTuiScreen();
            mountLaunch();
          }
        }
      });
    } catch (error) {
      failure = (error as Error).message;
    }

    if (!state) {
      instance?.unmount();
      mountLaunch(failure ?? "Start failed for an unknown reason.");
      await instance!.waitUntilExit();
      process.exitCode = 1;
      return;
    }

    instance?.unmount();
    await mountOverseer(state.statePath, options.cliPath, options.terminal);
  } finally {
    leaveTuiScreen();
  }
}
