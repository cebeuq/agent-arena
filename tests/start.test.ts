import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentLayouts, startArena, type StartEvent } from "../src/start.js";
import { commandExists } from "../src/shell.js";
import type { AgentInput, RunState } from "../src/types.js";

function agent(id: string): AgentInput {
  return {
    id,
    command: `${id}-agent {rivalDir}`,
    goalMode: "auto",
    resources: []
  };
}

describe("start layout generation", () => {
  it("creates workspaces and rival mirror paths for N agents", () => {
    const root = "/tmp/arena-workspaces";
    const layouts = buildAgentLayouts([agent("a"), agent("b"), agent("c")], root, "run-1", "Win.", "cli.js");

    expect(layouts.map((layout) => layout.input.id)).toEqual(["a", "b", "c"]);
    expect(layouts[0].workspace).toBe(path.join(root, "a"));
    expect(layouts[0].rivalsDir).toBe(path.join(root, "a", ".arena", "rivals"));
    expect(layouts[0].rivalDirs).toEqual({
      b: path.join(root, "a", ".arena", "rivals", "b"),
      c: path.join(root, "a", ".arena", "rivals", "c")
    });
    expect(layouts[0].launch.command).toBe(`a-agent ${path.join(root, "a", ".arena", "rivals")}`);
  });
});

const hasTmuxAndGit = commandExists("tmux") && commandExists("git");

describe.runIf(hasTmuxAndGit)("startArena staged reporter", () => {
  const cleanups: Array<() => void> = [];
  let tempDir: string | undefined;

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // best effort
      }
    }
    if (tempDir) {
      // Rival mirrors are chmod'd read-only; restore write permission before removal.
      spawnSync("chmod", ["-R", "u+w", tempDir], { stdio: "ignore" });
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("emits ordered stage events, calls the warmup hook, and skips attach when told", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arena-start-"));
    process.env.AGENT_ARENA_HOME = tempDir; // keep the run index out of ~/.agent-arena
    cleanups.push(() => {
      delete process.env.AGENT_ARENA_HOME;
    });
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
    await fs.writeFile(path.join(tempDir, "README.md"), "fixture\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-m", "init"],
      { cwd: tempDir, stdio: "ignore" }
    );

    const configPath = path.join(tempDir, "arena.config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        baseRepo: ".",
        goal: "Test run.",
        agents: [
          { id: "a", command: "sleep 600" },
          { id: "b", command: "sleep 600" }
        ],
        tmux: { sessionPrefix: "arena-start-test", attach: true }
      }),
      "utf8"
    );

    const events: StartEvent[] = [];
    const warmups: string[] = [];
    const state: RunState = await startArena({
      configPath,
      attach: true,
      cliPath: path.resolve("dist/cli.js"),
      reporter: (event) => events.push(event),
      runWarmup: async (warmupState) => {
        warmups.push(warmupState.runId);
      },
      attachWhenDone: false
    });

    cleanups.push(() => {
      spawnSync("tmux", ["kill-session", "-t", state.tmux.sessionName], { stdio: "ignore" });
      if (state.mirrorDaemonPid) {
        try {
          process.kill(state.mirrorDaemonPid);
        } catch {
          // already gone
        }
      }
    });

    const doneStages = events.flatMap((event) =>
      event.type === "stage" && event.status === "done" ? [event.stage] : []
    );
    expect(doneStages).toEqual([
      "preflight",
      "resources",
      "worktrees",
      "verifier",
      "warmup",
      "briefs",
      "register",
      "mirrors",
      "tmux",
      "daemon"
    ]);

    expect(warmups).toEqual([state.runId]);

    const infoLines = events.flatMap((event) => (event.type === "info" ? [event.message] : []));
    expect(infoLines.some((line) => line.startsWith("Started Agent Arena run "))).toBe(true);
    expect(infoLines.some((line) => line.startsWith("Attach later with: tmux attach-session"))).toBe(true);

    // attachWhenDone: false must skip the final attach entirely (no attach warnings).
    const warningLines = events.flatMap((event) => (event.type === "warning" ? [event.message] : []));
    expect(warningLines.some((line) => line.includes("Attach manually"))).toBe(false);

    expect(state.status).toBe("running");
    expect(state.agents).toHaveLength(2);
  }, 30000);
});

