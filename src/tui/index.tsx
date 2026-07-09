import fs from "node:fs/promises";
import path from "node:path";
import React from "react";
import { render } from "ink";
import { launchSetupHelper } from "../setup.js";
import { selectedAgentPresets } from "../tui-model.js";
import { resolveGitRoot } from "../worktree.js";
import { WizardApp, type ExitRequest } from "./app.js";
import { registerInkClear } from "./components/editor-escape.js";
import { runLaunchAndOverseer } from "./overseer/index.js";
import { enterTuiScreen, leaveTuiScreen } from "./screen-control.js";
import type { WizardInit } from "./state.js";
import { findNearbyGitRepos, loadExistingConfig } from "./view-models/project-vm.js";

export type TuiOptions = {
  cliPath: string;
  cwd?: string;
};

async function runWizardOnce(init: WizardInit): Promise<ExitRequest> {
  let exitRequest: ExitRequest = { kind: "quit" };
  enterTuiScreen();
  try {
    const instance = render(
      <WizardApp
        init={init}
        onExit={(request) => {
          exitRequest = request;
        }}
      />,
      { exitOnCtrlC: false }
    );
    registerInkClear(() => instance.clear());
    await instance.waitUntilExit();
  } finally {
    registerInkClear(undefined);
    leaveTuiScreen();
  }
  return exitRequest;
}

// Skips the write when the on-disk config is semantically identical, so
// starting a run never dirties a committed arena.config.json (a dirty base
// repo would later block `arena harvest`'s merge). Deep-equal, not byte-equal:
// hand-written or helper-written files may differ in key order or formatting.
export async function writeConfigIfChanged(configPath: string, config: unknown): Promise<void> {
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  try {
    const existing = await fs.readFile(configPath, "utf8");
    if (deepJsonEqual(JSON.parse(existing), JSON.parse(serialized))) {
      return;
    }
  } catch {
    // Missing or unparseable file: fall through and write.
  }
  await fs.writeFile(configPath, serialized, "utf8");
}

function deepJsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepJsonEqual(item, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
    const leftKeys = Object.keys(left as Record<string, unknown>);
    const rightKeys = Object.keys(right as Record<string, unknown>);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) =>
        deepJsonEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])
      )
    );
  }
  return false;
}

export async function runArenaTui(options: TuiOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  let repoRoot: string | undefined;
  try {
    repoRoot = resolveGitRoot(cwd);
  } catch {
    // The project screen will handle picking one.
  }

  const loaded = repoRoot ? await loadExistingConfig(repoRoot) : {};
  let init: WizardInit = {
    repoRoot,
    existingConfig: loaded.existingConfig,
    configError: loaded.existingConfigError,
    projectCandidates: repoRoot ? [] : await findNearbyGitRepos(cwd)
  };

  for (;;) {
    const request = await runWizardOnce(init);

    if (request.kind === "quit") {
      return;
    }

    if (request.kind === "start") {
      const configPath = path.join(request.repoRoot, "arena.config.json");
      await writeConfigIfChanged(configPath, request.config);
      await runLaunchAndOverseer({
        configPath,
        cliPath: options.cliPath
      });
      return;
    }

    // Helper round-trip: the helper runs in its own tmux session while the TUI is
    // unmounted, then the wizard re-enters at review (or task on failure).
    const result = await launchSetupHelper({
      repoRoot: request.repoRoot,
      selectedAgents: selectedAgentPresets(request.draft),
      helper: request.helper,
      cliPath: options.cliPath,
      feedback: request.feedback,
      priorDraft: request.draft
    });

    const reloaded = await loadExistingConfig(request.repoRoot);
    init = {
      repoRoot: request.repoRoot,
      existingConfig: reloaded.existingConfig,
      configError: reloaded.existingConfigError,
      draft: result.draft ?? request.draft,
      stack: result.ok
        ? [{ name: "project" }, { name: "teams" }, { name: "task" }, { name: "review" }]
        : [{ name: "project" }, { name: "teams" }, { name: "task" }],
      notices: [
        ...result.warnings,
        ...(result.blockedChanges ? [`Helper changed project files outside allowed outputs:\n${result.blockedChanges}`] : [])
      ],
      projectCandidates: []
    };
  }
}
