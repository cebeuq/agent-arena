import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30000,
    // The Ink TUI tests drive real keystroke timing and the integration tests
    // spawn tmux sessions and git worktrees; running files in parallel makes
    // both flaky under load. The single retry absorbs residual fake-terminal
    // timing noise; deterministic failures still fail every attempt.
    fileParallelism: false,
    retry: 1
  }
});
