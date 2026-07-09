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
      await fs.writeFile(configPath, `${JSON.stringify(request.config, null, 2)}\n`, "utf8");
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
