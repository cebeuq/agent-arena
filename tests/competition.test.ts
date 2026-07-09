import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectAgentProgress,
  collectAgentProgressAsync,
  notifyRivalsOfClaim,
  sendPeriodicCompetitionNotices,
  updateCompetitionArtifacts
} from "../src/competition.js";
import type { RunAgent, RunState } from "../src/types.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function initWorkspace(root: string, id: string): Promise<string> {
  const workspace = path.join(root, "workspaces", id);
  await fs.mkdir(path.join(workspace, ".arena", "rivals"), { recursive: true });
  spawnSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src", `${id}.ts`), `export const ${id} = true;\n`, "utf8");
  return workspace;
}

function agent(id: string, workspace: string, rivalId: string): RunAgent {
  return {
    id,
    name: `Agent ${id.toUpperCase()}`,
    command: `fake-${id}`,
    configuredGoalMode: "prompt",
    launchMode: "prompt",
    resources: [],
    workspace,
    branch: id,
    goalFile: path.join(workspace, ".arena", "goal.md"),
    briefFile: path.join(workspace, ".arena", "brief.md"),
    claimScript: path.join(workspace, ".arena", "claim.sh"),
    claimCommand: `claim-${id}`,
    rivalsDir: path.join(workspace, ".arena", "rivals"),
    rivalDirs: {
      [rivalId]: path.join(workspace, ".arena", "rivals", rivalId)
    },
    paneId: `%${id}`
  };
}

async function makeState(): Promise<RunState> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-arena-competition-"));
  tempDirs.push(root);
  const workspaceA = await initWorkspace(root, "a");
  const workspaceB = await initWorkspace(root, "b");
  const runDir = path.join(root, "runs", "run-1");
  await fs.mkdir(runDir, { recursive: true });

  return {
    runId: "run-1",
    status: "running",
    startedAt: new Date(Date.now() - 181000).toISOString(),
    baseRepo: root,
    baseRef: "HEAD",
    arenaRoot: root,
    runDir,
    statePath: path.join(runDir, "state.json"),
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
    agents: [agent("a", workspaceA, "b"), agent("b", workspaceB, "a")],
    claims: []
  };
}

describe("competition director", () => {
  it("writes scoreboard and rival summary files with progress and paths", async () => {
    const state = await makeState();
    state.claims.push({
      agentId: "a",
      claimedAt: "2026-06-08T00:00:00.000Z",
      verifiedAt: "2026-06-08T00:00:00.000Z",
      status: "pending",
      stdout: "",
      stderr: ""
    });

    await updateCompetitionArtifacts(state, new Date("2026-06-08T00:03:01.000Z"));

    const scoreboard = await fs.readFile(path.join(state.agents[0].workspace, ".arena", "scoreboard.md"), "utf8");
    expect(scoreboard).toContain("Agent A (a): 1 changed file");
    expect(scoreboard).toContain("a at 2026-06-08T00:00:00.000Z");
    expect(scoreboard).toContain(state.agents[0].rivalDirs.b);

    const rivalSummary = await fs.readFile(path.join(state.agents[0].workspace, ".arena", "rival-summary.md"), "utf8");
    expect(rivalSummary).toContain("Agent B (b)");
    expect(rivalSummary).toContain("src/b.ts");
    expect(state.competitionStatus?.lastDirectorUpdate).toBe("2026-06-08T00:03:01.000Z");
  });

  it("sends balanced periodic notices only after the configured interval", async () => {
    const state = await makeState();
    const messages: string[] = [];

    const sent = sendPeriodicCompetitionNotices(state, new Date(), (_pane, message) => messages.push(message));
    expect(sent).toBe(true);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("ARENA UPDATE");

    const skipped = sendPeriodicCompetitionNotices(state, new Date(Date.now() + 1000), (_pane, message) =>
      messages.push(message)
    );
    expect(skipped).toBe(false);
    expect(messages).toHaveLength(2);
  });

  it("builds claim notices for rivals with claimant changed files", async () => {
    const state = await makeState();
    const messages: Array<{ pane?: string; message: string }> = [];

    const sent = notifyRivalsOfClaim(state, "a", new Date("2026-06-08T00:05:00.000Z"), (pane, message) => {
      messages.push({ pane, message });
    });

    expect(sent).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].pane).toBe("%b");
    expect(messages[0].message).toContain("Agent A submitted a finish claim");
    expect(messages[0].message).toContain("src/a.ts");
    expect(messages[0].message).toContain(".arena/rivals/a");
  });

  it("passes the recipient's harness preset to the notice sender (for the steer key)", async () => {
    const state = await makeState();
    // Rival "b" runs Codex, which needs Tab (not Enter) to queue a steer.
    state.agents[1].preset = "codex";
    const sends: Array<{ pane?: string; preset?: string }> = [];

    notifyRivalsOfClaim(state, "a", new Date("2026-06-08T00:05:00.000Z"), (pane, _message, preset) => {
      sends.push({ pane, preset });
    });

    expect(sends).toEqual([{ pane: "%b", preset: "codex" }]);
  });

  it("collects changed-file counts while ignoring arena internals", async () => {
    const state = await makeState();
    await fs.writeFile(path.join(state.agents[0].workspace, ".arena", "scoreboard.md"), "ignored\n", "utf8");

    const progress = collectAgentProgress(state);

    expect(progress.find((item) => item.agentId === "a")?.changedFiles).toEqual(["src/a.ts"]);
  });

  it("keeps the first changed file intact when the first status line starts with a space", async () => {
    // A modified-but-unstaged file renders as " M path" in `git status --short`.
    // A whole-output trim used to strip that leading space, making the parser
    // eat the first character of the first path ("package.json" -> "ackage.json").
    const state = await makeState();
    const workspace = state.agents[0].workspace;
    const git = (...args: string[]) => spawnSync("git", args, { cwd: workspace, stdio: "ignore" });
    git("config", "user.email", "arena@test.local");
    git("config", "user.name", "Arena Test");
    git("add", "src");
    git("commit", "-m", "seed");
    await fs.writeFile(path.join(workspace, "src", "a.ts"), "export const a = false;\n", "utf8");

    const sync = collectAgentProgress(state);
    const live = await collectAgentProgressAsync(state);

    expect(sync.find((item) => item.agentId === "a")?.changedFiles).toEqual(["src/a.ts"]);
    expect(live.find((item) => item.agentId === "a")?.changedFiles).toEqual(["src/a.ts"]);
  });
});
