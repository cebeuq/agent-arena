import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchTmux } from "../src/tmux.js";
import type { RunAgent, RunState } from "../src/types.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-arena-tmux-"));
  tempDirs.push(root);
  return root;
}

function agent(id: string): RunAgent {
  return {
    id,
    name: id,
    codename: id,
    teamId: id === "c" ? "blue" : "red",
    teamName: id === "c" ? "Team Blue" : "Team Red",
    captainAgentId: id === "c" ? "c" : "a",
    isCaptain: id === "a" || id === "c",
    command: `${id}-agent`,
    configuredGoalMode: "prompt",
    launchMode: "prompt",
    teamResources: [],
    resources: [],
    workspace: `/tmp/${id}`,
    branch: id,
    goalFile: `/tmp/${id}/.arena/goal.md`,
    briefFile: `/tmp/${id}/.arena/brief.md`,
    claimScript: `/tmp/${id}/.arena/claim.sh`,
    claimCommand: `claim-${id}`,
    chatScript: `/tmp/${id}/.arena/chat.sh`,
    chatCommand: `chat-${id}`,
    chatInboxCommand: `chat-${id} inbox`,
    chatHistoryCommand: `chat-${id} history`,
    proposePatchScript: `/tmp/${id}/.arena/propose-patch.sh`,
    proposePatchCommand: `proposal-${id}`,
    applyProposalScript: `/tmp/${id}/.arena/apply-proposal.sh`,
    applyProposalCommand: `apply-${id}`,
    rivalsDir: `/tmp/${id}/.arena/rivals`,
    rivalDirs: {}
  };
}

describe("tmux launcher", () => {
  it("creates team windows with agent panes and returns agent pane ids", () => {
    const calls: string[][] = [];
    let nextPane = 0;
    const state: RunState = {
      runId: "run-1",
      status: "running",
      startedAt: new Date().toISOString(),
      baseRepo: "/tmp/repo",
      baseRef: "HEAD",
      arenaRoot: "/tmp/repo/.agent-arena",
      runDir: "/tmp/repo/.agent-arena/runs/run-1",
      statePath: "/tmp/repo/.agent-arena/runs/run-1/state.json",
      goal: "Win.",
      successCriteria: [],
      resources: [],
      teams: [
        {
          id: "red",
          name: "Team Red",
          captainAgentId: "a",
          agentIds: ["a", "b"],
          resources: []
        },
        {
          id: "blue",
          name: "Team Blue",
          captainAgentId: "c",
          agentIds: ["c"],
          resources: []
        }
      ],
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
      agents: [agent("a"), agent("b"), agent("c")],
      claims: []
    };

    const result = launchTmux(state, (args) => {
      calls.push(args);
      return args.includes("#{pane_id}") ? `%${nextPane++}` : "";
    });

    expect(result).toEqual({
      a: "%1",
      b: "%2",
      c: "%4"
    });
    expect(calls.filter((args) => args[0] === "new-session")).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "new-window")).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "split-window")).toHaveLength(3);
    expect(calls.some((args) => args.some((arg) => arg.includes("tui team-sidebar")))).toBe(true);
    // The team chat pane was replaced by the overseer's chat view.
    expect(calls.some((args) => args.some((arg) => arg.includes("tui team-chat")))).toBe(false);
    expect(calls.some((args) => args.some((arg) => arg.includes("CAPTAIN")))).toBe(true);
    expect(calls.some((args) => args.includes("tiled"))).toBe(false);
  });

  it("injects saved secret env resources into agent commands", async () => {
    const root = await tempRoot();
    const arenaRoot = path.join(root, ".agent-arena");
    await fs.mkdir(arenaRoot, { recursive: true });
    await fs.writeFile(path.join(arenaRoot, "secrets.env"), "SERVICE_API_KEY=from-secret\n", "utf8");

    const calls: string[][] = [];
    const state: RunState = {
      runId: "run-1",
      status: "running",
      startedAt: new Date().toISOString(),
      baseRepo: root,
      baseRef: "HEAD",
      arenaRoot,
      runDir: path.join(arenaRoot, "runs", "run-1"),
      statePath: path.join(arenaRoot, "runs", "run-1", "state.json"),
      goal: "Win.",
      successCriteria: [],
      resources: [
        {
          type: "env",
          name: "Service key",
          envVar: "SERVICE_API_KEY"
        }
      ],
      teams: [
        {
          id: "red",
          name: "Team Red",
          captainAgentId: "a",
          agentIds: ["a", "b"],
          resources: []
        }
      ],
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
      agents: [agent("a"), agent("b")],
      claims: []
    };

    launchTmux(state, (args) => {
      calls.push(args);
      return args.includes("#{pane_id}") ? `%${calls.length}` : "";
    });

    const command = calls.find((args) => (args.at(-1) ?? "").includes("a-agent"))?.at(-1) ?? "";
    expect(command).toContain("SERVICE_API_KEY=from-secret");
    expect(command).toContain("a-agent");
  });
});
