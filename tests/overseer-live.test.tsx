import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import React from "react";
import { render } from "ink-testing-library";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimRun } from "../src/claim.js";
import { commandExists } from "../src/shell.js";
import { startArena } from "../src/start.js";
import type { RunState } from "../src/types.js";
import { createActions } from "../src/tui/overseer/actions.js";
import { createRunWatcher, type RunWatcher } from "../src/tui/overseer/run-watcher.js";
import { OverseerApp } from "../src/tui/overseer/overseer-app.js";

const hasTmuxAndGit = commandExists("tmux") && commandExists("git");

let tempDir: string;
let state: RunState;
let watcher: RunWatcher;

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
}

async function press(stdin: { write: (data: string) => void }, data: string): Promise<void> {
  stdin.write(data);
  await new Promise((resolve) => setTimeout(resolve, 60));
}

describe.runIf(hasTmuxAndGit)("overseer against a live run", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arena-live-"));
    process.env.AGENT_ARENA_HOME = tempDir; // keep the run index out of ~/.agent-arena
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
    await fs.writeFile(path.join(tempDir, "README.md"), "live fixture\n", "utf8");
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
        goal: "Live overseer integration fixture.",
        agents: [
          { id: "alpha", command: "sleep 600" },
          { id: "beta", command: "sleep 600" }
        ],
        tmux: { sessionPrefix: "arena-live-test", attach: false }
      }),
      "utf8"
    );

    state = await startArena({
      configPath,
      attach: false,
      cliPath: path.resolve("dist/cli.js"),
      reporter: () => {}
    });
    watcher = createRunWatcher({ statePath: state.statePath, stateIntervalMs: 60, progressIntervalMs: 300 });
  }, 30000);

  afterAll(async () => {
    delete process.env.AGENT_ARENA_HOME;
    watcher?.stop();
    if (state) {
      spawnSync("tmux", ["kill-session", "-t", state.tmux.sessionName], { stdio: "ignore" });
      if (state.mirrorDaemonPid) {
        try {
          process.kill(state.mirrorDaemonPid);
        } catch {
          // already gone
        }
      }
    }
    if (tempDir) {
      spawnSync("chmod", ["-R", "u+w", tempDir], { stdio: "ignore" });
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("drives the real run end to end: dashboard, Director chat, reject, accept, winner", async () => {
    const actions = createActions({
      runId: state.runId,
      statePath: state.statePath,
      cliPath: path.resolve("dist/cli.js"),
      watcher
    });
    await watcher.refreshNow();
    const initialSnapshot = watcher.current();
    expect(initialSnapshot).toBeDefined();

    const { stdin, lastFrame } = render(
      <OverseerApp watcher={watcher} actions={actions} initialSnapshot={initialSnapshot!} />
    );

    // Dashboard shows both live agents.
    await waitFor(() => {
      expect(lastFrame()).toContain("RUNNING");
      expect(lastFrame()).toContain("(alpha)");
      expect(lastFrame()).toContain("(beta)");
    });

    // Director chat: switch to chat, focus input, send to the public thread.
    await press(stdin, "2");
    await waitFor(() => expect(lastFrame()).toContain("Threads"));
    await press(stdin, "\r"); // Enter on the selected thread focuses the input
    stdin.write("hello agents, Director here");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await press(stdin, "\r");
    // "Director:" only appears in the rendered message log, never in the input echo.
    await waitFor(() => expect(lastFrame()).toContain("Director: hello agents, Director here"));

    // The message must land in a real agent workspace artifact.
    const alphaPublic = path.join(state.agents[0].workspace, ".arena", "chat", "public.md");
    await waitFor(async () => {
      const publicMd = await fs.readFile(alphaPublic, "utf8");
      expect(publicMd).toContain("hello agents, Director here");
    });

    // Leave the chat input (Esc) so number keys navigate views again.
    await press(stdin, "\x1b");

    // An agent claims (as the claim script would); banner appears.
    await claimRun({ runId: state.runId, agentId: "alpha", statePath: state.statePath });
    await waitFor(() => expect(lastFrame()).toContain("claims finish"));

    // Reject with a note from the judge view.
    await press(stdin, "4");
    await waitFor(() => expect(lastFrame()).toContain("Pending claims (1)"));
    await press(stdin, "x");
    await waitFor(() => expect(lastFrame()).toContain(`Reject ${state.agents[0].codename ?? "alpha"}'s claim`));
    stdin.write("needs verification");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await press(stdin, "\r");
    await waitFor(() => expect(lastFrame()).toContain("Pending claims (0)"), 8000);

    // Claim again and accept through the danger confirm; run finishes.
    await claimRun({ runId: state.runId, agentId: "alpha", statePath: state.statePath });
    await waitFor(() => expect(lastFrame()).toContain("Claim by"));
    // Retry the keypress until the confirm appears: the claim list re-derives its
    // selection across the (0)->(1) snapshot transition, so a single press can
    // race the commit.
    await waitFor(async () => {
      if (!lastFrame()!.includes("Accept claim and END the run?")) {
        await press(stdin, "a");
        throw new Error("confirm not open yet");
      }
    });
    await press(stdin, "y");
    await waitFor(() => {
      expect(lastFrame()).toContain(`WINNER: ${state.agents[0].codename ?? "alpha"}`);
      expect(lastFrame()).toContain("FINISHED");
    }, 15000);

    const finalState = JSON.parse(await fs.readFile(state.statePath, "utf8")) as RunState;
    expect(finalState.status).toBe("finished");
    expect(finalState.winner?.agentId).toBe("alpha");
    expect(finalState.claims.map((claim) => claim.status)).toEqual(["rejected", "accepted"]);
  }, 60000);
});
