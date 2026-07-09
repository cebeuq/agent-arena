import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLatestLocalStatePath, writeRunState } from "../src/run-state.js";
import type { RunState } from "../src/types.js";

let tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.AGENT_ARENA_HOME;
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-arena-state-"));
  tempDirs.push(root);
  // Run discovery also consults the global index; keep it isolated from the
  // developer's real ~/.agent-arena/runs.json.
  process.env.AGENT_ARENA_HOME = root;
  return root;
}

function state(root: string, runId: string, status: RunState["status"], startedAt: string): RunState {
  const workspace = path.join(root, "workspaces", runId, "agent");
  return {
    runId,
    status,
    startedAt,
    finishedAt: status === "finished" ? new Date(new Date(startedAt).getTime() + 1000).toISOString() : undefined,
    baseRepo: root,
    baseRef: "HEAD",
    arenaRoot: path.join(root, ".agent-arena"),
    runDir: path.join(root, ".agent-arena", "runs", runId),
    statePath: path.join(root, ".agent-arena", "runs", runId, "state.json"),
    goal: `Goal for ${runId}`,
    successCriteria: [],
    resources: [],
    judging: {
      mode: "manual"
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
        id: "agent",
        name: "Agent",
        codename: "Nova",
        teamId: "team",
        teamName: "Team",
        captainAgentId: "agent",
        isCaptain: true,
        command: "agent",
        configuredGoalMode: "prompt",
        launchMode: "prompt",
        teamResources: [],
        resources: [],
        workspace,
        branch: "agent",
        goalFile: path.join(workspace, ".arena", "goal.md"),
        briefFile: path.join(workspace, ".arena", "brief.md"),
        claimScript: path.join(workspace, ".arena", "claim.sh"),
        claimCommand: "claim",
        chatScript: path.join(workspace, ".arena", "chat.sh"),
        chatCommand: "chat",
        chatInboxCommand: "chat inbox",
        chatHistoryCommand: "chat history",
        proposePatchScript: path.join(workspace, ".arena", "propose-patch.sh"),
        proposePatchCommand: "proposal",
        applyProposalScript: path.join(workspace, ".arena", "apply-proposal.sh"),
        applyProposalCommand: "apply",
        rivalsDir: path.join(workspace, ".arena", "rivals"),
        rivalDirs: {}
      }
    ],
    claims: []
  };
}

describe("run state persistence", () => {
  it("redacts per-agent env values when writing state", async () => {
    const root = await tempRoot();
    const statePath = path.join(root, "state.json");
    const state: RunState = {
      runId: "run-1",
      status: "running",
      startedAt: new Date().toISOString(),
      baseRepo: root,
      baseRef: "HEAD",
      arenaRoot: path.join(root, ".agent-arena"),
      runDir: root,
      statePath,
      goal: "Win.",
      successCriteria: [],
      resources: [],
      judging: {
        mode: "manual"
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
          id: "codex",
          name: "codex",
          command: "codex",
          configuredGoalMode: "prompt",
          launchMode: "prompt",
          env: {
            SERVICE_API_KEY: "raw-secret"
          },
          resources: [],
          workspace: path.join(root, "codex"),
          branch: "codex",
          goalFile: path.join(root, "codex", ".arena", "goal.md"),
          briefFile: path.join(root, "codex", ".arena", "brief.md"),
          claimScript: path.join(root, "codex", ".arena", "claim.sh"),
          claimCommand: "claim",
          rivalsDir: path.join(root, "codex", ".arena", "rivals"),
          rivalDirs: {}
        }
      ],
      claims: []
    };

    await writeRunState(state);

    const raw = await fs.readFile(statePath, "utf8");
    expect(raw).toContain("SERVICE_API_KEY");
    expect(raw).toContain("<redacted>");
    expect(raw).not.toContain("raw-secret");
  });

  it("infers the single active local run from the current repo", async () => {
    const root = await tempRoot();
    const finished = state(root, "finished-run", "finished", "2026-06-08T00:00:00.000Z");
    const running = state(root, "running-run", "running", "2026-06-08T01:00:00.000Z");
    await writeRunState(finished);
    await writeRunState(running);

    await expect(resolveLatestLocalStatePath(root)).resolves.toBe(running.statePath);
  });

  it("asks for --run when multiple local runs are active", async () => {
    const root = await tempRoot();
    await writeRunState(state(root, "run-a", "running", "2026-06-08T00:00:00.000Z"));
    await writeRunState(state(root, "run-b", "running", "2026-06-08T01:00:00.000Z"));

    await expect(resolveLatestLocalStatePath(root)).rejects.toThrow("Multiple local runs are still running");
  });

  it("falls back to the latest finished run when none are active", async () => {
    const root = await tempRoot();
    const older = state(root, "older", "finished", "2026-06-08T00:00:00.000Z");
    const newer = state(root, "newer", "finished", "2026-06-08T02:00:00.000Z");
    await writeRunState(older);
    await writeRunState(newer);

    await expect(resolveLatestLocalStatePath(root)).resolves.toBe(newer.statePath);
  });
});
