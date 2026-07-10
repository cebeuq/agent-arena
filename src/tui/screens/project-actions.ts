import { existsSync } from "node:fs";
import { createNewProject } from "../../setup.js";
import { resolveGitRoot } from "../../worktree.js";
import type { AppShellStatus } from "../components/AppShell.js";
import type { WizardAction } from "../state.js";
import { loadExistingConfig } from "../view-models/project-vm.js";

export type ProjectActionDeps = {
  dispatch: React.Dispatch<WizardAction>;
  showToast: (text: string, tone?: AppShellStatus["tone"]) => void;
};

// Loads an existing git repository as the project (validating it is a repo and
// reading any arena.config.json). Shared by the source list and the browser.
export async function selectProject(deps: ProjectActionDeps, candidate: string): Promise<boolean> {
  deps.dispatch({ type: "setBusy", busy: { label: `Loading ${candidate}…` } });
  try {
    const resolvedRoot = resolveGitRoot(candidate);
    const loaded = await loadExistingConfig(resolvedRoot);
    deps.dispatch({
      type: "projectLoaded",
      repoRoot: resolvedRoot,
      config: loaded.existingConfig,
      error: loaded.existingConfigError
    });
    if (loaded.existingConfigError) {
      deps.showToast(loaded.existingConfigError, "error");
    } else {
      deps.showToast(`Loaded ${resolvedRoot}`, "info");
    }
    return true;
  } catch {
    deps.showToast(
      existsSync(candidate) ? "That path is not inside a git repository." : "That path does not exist.",
      "error"
    );
    return false;
  } finally {
    deps.dispatch({ type: "setBusy", busy: undefined });
  }
}

// Creates a fresh git project (README + .gitignore + initial commit) at the
// target path and loads it. Returns false with a toast on failure.
export async function createProject(deps: ProjectActionDeps, target: string): Promise<boolean> {
  deps.dispatch({ type: "setBusy", busy: { label: `Creating ${target}…` } });
  try {
    const created = await createNewProject(target);
    const loaded = await loadExistingConfig(created.repoRoot);
    deps.dispatch({
      type: "projectLoaded",
      repoRoot: created.repoRoot,
      config: loaded.existingConfig,
      error: loaded.existingConfigError
    });
    deps.dispatch({ type: "setNotices", notices: created.warnings });
    deps.showToast(`Created ${created.repoRoot}`, "info");
    return true;
  } catch (error) {
    deps.showToast((error as Error).message, "error");
    return false;
  } finally {
    deps.dispatch({ type: "setBusy", busy: undefined });
  }
}
