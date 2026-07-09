import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeRunState } from "../src/run-state.js";
import { printStatus } from "../src/status.js";
import type { RunState } from "../src/types.js";

let tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("status output", () => {
  it("prints run and pending claim details", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-arena-status-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspaces", "a");
    await fs.mkdir(workspace, { recursive: true });
    const statePath = path.join(root, "runs", "run-1", "state.json");
    const state: RunState = {
      runId: "run-1",
      status: "running",
      startedAt: new Date().toISOString(),
      baseRepo: root,
      baseRef: "HEAD",
      arenaRoot: root,
      runDir: path.dirname(statePath),
      statePath,
      goal: "Win.",
      successCriteria: [],
      resources: [],
      judging: {
        mode: "manual"
      },
      competitionStatus: {
        lastDirectorUpdate: "2026-06-08T00:03:00.000Z"
      },
      peek: {
        refreshIntervalSeconds: 30,
        include: ["**/*"],
        exclude: []
      },
      tmux: {
        sessionName: "arena",
        attach: false
      },
      agents: [
        {
          id: "a",
          name: "Agent A",
          command: "fake-a",
          configuredGoalMode: "prompt",
          launchMode: "prompt",
          resources: [],
          workspace,
          branch: "a",
          goalFile: path.join(workspace, ".arena", "goal.md"),
          briefFile: path.join(workspace, ".arena", "brief.md"),
          claimScript: path.join(workspace, ".arena", "claim.sh"),
          claimCommand: "claim-a",
          rivalsDir: path.join(workspace, ".arena", "rivals"),
          rivalDirs: {}
        }
      ],
      claims: [
        {
          agentId: "a",
          claimedAt: "2026-06-08T00:02:00.000Z",
          status: "pending",
          stdout: "",
          stderr: ""
        }
      ]
    };
    await writeRunState(state);

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      lines.push(String(message ?? ""));
    });

    await printStatus(state.runId, statePath);

    const output = lines.join("\n");
    expect(output).toContain("Director updated: 2026-06-08T00:03:00.000Z");
    expect(output).toContain("Pending claims:");
    expect(output).toContain("a: pending at 2026-06-08T00:02:00.000Z");
    expect(output).toContain("changed files: 0");
  });
});
