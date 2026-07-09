import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import React from "react";
import { render } from "ink-testing-library";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WizardApp, type ExitRequest } from "../src/tui/app.js";
import { parseArenaConfig } from "../src/config.js";

let repoRoot: string;

beforeAll(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "arena-wizard-"));
  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
  await fs.writeFile(path.join(repoRoot, "README.md"), "# fixture\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "init"],
    { cwd: repoRoot, stdio: "ignore" }
  );
});

afterAll(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

async function waitFor(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function press(stdin: { write: (data: string) => void }, data: string): Promise<void> {
  stdin.write(data);
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("setup wizard happy path", () => {
  it("walks project -> teams -> task -> review and produces a valid config", async () => {
    let exit: ExitRequest | undefined;
    const { stdin, lastFrame } = render(
      <WizardApp
        init={{ repoRoot, projectCandidates: [] }}
        onExit={(request) => {
          exit = request;
        }}
      />
    );

    // Project screen.
    await waitFor(() => expect(lastFrame()).toContain("▸ Use this project"));
    await press(stdin, "\r");

    // Teams screen with the default red/blue draft.
    await waitFor(() => {
      expect(lastFrame()).toContain("Teams & Agents");
      expect(lastFrame()).toContain("red-codex");
      expect(lastFrame()).toContain("blue-claude");
    });
    await press(stdin, "\x1b[C"); // right -> Task

    // Task screen: select the Goal field and type a goal. Every keystroke waits
    // for its observable effect so the test cannot outrun React commits.
    await waitFor(() => expect(lastFrame()).toContain("Setup — Task"));
    await press(stdin, "\x1b[B"); // down to Goal
    await waitFor(() => expect(lastFrame()).toContain("▸ Goal"));
    await press(stdin, "\r"); // edit goal
    await waitFor(() => expect(lastFrame()).toContain("What should the competing agents accomplish?"));
    stdin.write("Build the fastest parser");
    await waitFor(() => expect(lastFrame()).toContain("Build the fastest parser"));
    await press(stdin, "\r"); // submit goal
    // The "(e: $EDITOR)" suffix only renders in display mode, proving the edit closed.
    await waitFor(() => expect(lastFrame()).toContain("(e: $EDITOR)"));
    await press(stdin, "\x1b[C"); // right -> Review

    // Review screen: Start arena -> confirm.
    await waitFor(() => expect(lastFrame()).toContain("Review & Start"));
    await waitFor(() => expect(lastFrame()).toContain("▸ Start arena"));
    await press(stdin, "\r"); // activate Start
    await waitFor(() => expect(lastFrame()).toContain("Start the arena?"));
    await press(stdin, "\r"); // confirm

    await waitFor(() => expect(exit).toBeDefined());
    expect(exit!.kind).toBe("start");
    if (exit!.kind !== "start") {
      return;
    }
    expect(exit!.repoRoot).toBe(repoRoot);
    const config = parseArenaConfig(JSON.parse(JSON.stringify(exit!.config)));
    expect(config.goal).toBe("Build the fastest parser");
    expect(config.agents).toHaveLength(2);
    expect(config.teams).toHaveLength(2);
  });

  it("Esc pops back one screen instead of quitting", async () => {
    let exit: ExitRequest | undefined;
    const { stdin, lastFrame } = render(
      <WizardApp
        init={{ repoRoot, projectCandidates: [] }}
        onExit={(request) => {
          exit = request;
        }}
      />
    );

    await waitFor(() => expect(lastFrame()).toContain("▸ Use this project"));
    await press(stdin, "\r");
    await waitFor(() => expect(lastFrame()).toContain("Teams & Agents"));
    await press(stdin, "\x1b"); // Esc -> back to project
    await waitFor(() => expect(lastFrame()).toContain("Where will the arena run?"));
    expect(exit).toBeUndefined();
  });

  it("opens the agent editor from the team table and edits the model", async () => {
    const { stdin, lastFrame } = render(
      <WizardApp init={{ repoRoot, projectCandidates: [] }} onExit={() => {}} />
    );

    await waitFor(() => expect(lastFrame()).toContain("▸ Use this project"));
    await press(stdin, "\r");
    await waitFor(() => expect(lastFrame()).toContain("red-codex"));
    await press(stdin, "\r"); // Enter on first agent row
    await waitFor(() => expect(lastFrame()).toContain("Setup — Edit agent red-codex"));
    await press(stdin, "\x1b[B"); // down to Model
    await waitFor(() => expect(lastFrame()).toContain("▸ Model"));
    await press(stdin, "\r"); // open model picker
    await waitFor(() => expect(lastFrame()).toContain("GPT-5 Codex"));
    await press(stdin, "\x1b[B"); // down to gpt-5-codex
    await waitFor(() => expect(lastFrame()).toContain("▸ GPT-5 Codex"));
    await press(stdin, "\r");
    await waitFor(() => expect(lastFrame()).toContain("gpt-5-codex"));
    await press(stdin, "\x1b"); // Esc back to teams
    await waitFor(() => expect(lastFrame()).toContain("Teams & Agents"));
    await waitFor(() => expect(lastFrame()).toContain("gpt-5-codex"));
  });
});
