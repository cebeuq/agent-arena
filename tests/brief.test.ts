import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAgentBrief } from "../src/brief.js";
import type { RunAgent, RunState } from "../src/types.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function makeState(): Promise<RunState> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-arena-brief-"));
  tempDirs.push(root);
  const workspace = path.join(root, "workspace");
  const rivalWorkspace = path.join(root, "rival-workspace");

  const agent: RunAgent = {
    id: "codex",
    name: "Codex",
    preset: "codex",
    binary: "codex",
    command: "codex -c features.goals=true '/goal Read .arena/goal.md'",
    configuredGoalMode: "auto",
    launchMode: "goal",
    goalCapability: {
      supported: true,
      detectedVersion: "0.133.0",
      minimumVersion: "0.133.0"
    },
    instructions: "Prefer a small, benchmark-backed patch.",
    resources: [
      {
        type: "gpu",
        name: "Shared GPU box",
        host: "gpu.local",
        description: "Use only if benchmarks need GPU access.",
        usage: "Run GPU-backed benchmark experiments.",
        whenToUse: "Use when local CPU is too slow for benchmark evidence.",
        cleanup: "Stop any remote jobs when finished.",
        verification: "Record the command that proves the GPU job ran."
      }
    ],
    workspace,
    branch: "agent-arena/run/codex",
    goalFile: path.join(workspace, ".arena", "goal.md"),
    briefFile: path.join(workspace, ".arena", "brief.md"),
    claimScript: path.join(workspace, ".arena", "claim.sh"),
    claimCommand: "node cli.js claim --run run-1 --agent codex",
    rivalsDir: path.join(workspace, ".arena", "rivals"),
    rivalDirs: {
      claude: path.join(workspace, ".arena", "rivals", "claude")
    }
  };

  const rival: RunAgent = {
    id: "claude",
    name: "Claude",
    preset: "claude",
    command: "claude 'Read .arena/goal.md'",
    configuredGoalMode: "auto",
    launchMode: "prompt",
    resources: [],
    workspace: rivalWorkspace,
    branch: "agent-arena/run/claude",
    goalFile: path.join(rivalWorkspace, ".arena", "goal.md"),
    briefFile: path.join(rivalWorkspace, ".arena", "brief.md"),
    claimScript: path.join(rivalWorkspace, ".arena", "claim.sh"),
    claimCommand: "node cli.js claim --run run-1 --agent claude",
    rivalsDir: path.join(rivalWorkspace, ".arena", "rivals"),
    rivalDirs: {
      codex: path.join(rivalWorkspace, ".arena", "rivals", "codex")
    }
  };

  return {
    runId: "run-1",
    status: "running",
    startedAt: new Date().toISOString(),
    baseRepo: root,
    baseRef: "HEAD",
    arenaRoot: root,
    runDir: path.join(root, "runs", "run-1"),
    statePath: path.join(root, "runs", "run-1", "state.json"),
    goal: "Make the benchmark 3x faster without changing output correctness.",
    successCriteria: ["Benchmark is at least 3x faster.", "Existing tests pass."],
    resources: [
      {
        type: "env",
        name: "OpenAI key",
        envVar: "OPENAI_API_KEY",
        usage: "Call the OpenAI API when benchmark setup requires it.",
        whenToUse: "Use only for API-backed checks."
      }
    ],
    judging: {
      mode: "manual"
    },
    peek: {
      refreshIntervalSeconds: 30,
      include: ["**/*"],
      exclude: [".arena/**", ".git/**"]
    },
    tmux: {
      sessionName: "arena-run",
      attach: false
    },
    agents: [agent, rival],
    claims: []
  };
}

describe("agent brief generation", () => {
  it("writes a rich goal contract and concise brief", async () => {
    const state = await makeState();
    const [agent, rival] = state.agents;

    await writeAgentBrief(agent, [rival], state);

    const goal = await fs.readFile(agent.goalFile, "utf8");
    expect(goal).toContain("# Agent Arena Goal");
    expect(goal).toContain("Make the benchmark 3x faster");
    expect(goal).toContain("Benchmark is at least 3x faster.");
    expect(goal).toContain("Judging mode: manual user review.");
    expect(goal).toContain("./.arena/claim.sh");
    expect(goal).toContain("`codex`");
    expect(goal).toContain(agent.rivalDirs.claude);
    expect(goal).toContain("OpenAI key");
    expect(goal).toContain("Shared GPU box");
    expect(goal).toContain("Prefer a small, benchmark-backed patch.");
    expect(goal).toContain("Do not edit files under `.arena/`");
    expect(goal).toContain("./.arena/check-resources.sh");
    expect(goal).toContain(".arena/resources.json");
    expect(goal).toContain(".arena/resource-orders.md");
    expect(goal).toContain(".arena/competition.md");
    expect(goal).toContain(".arena/scoreboard.md");
    expect(goal).toContain(".arena/rival-summary.md");
    expect(goal).toContain("optional tactical context");
    expect(goal).toContain("Do not spend time on them if your current path is clearly productive.");

    const brief = await fs.readFile(agent.briefFile, "utf8");
    expect(brief).toContain("cat .arena/goal.md");
    expect(brief).toContain("Launch mode: goal");
    expect(brief).toContain("./.arena/check-resources.sh");
    expect(brief).toContain("cat .arena/resource-orders.md");
    expect(brief).toContain(".arena/scoreboard.md");

    const arenaDir = path.dirname(agent.goalFile);
    const resources = JSON.parse(await fs.readFile(path.join(arenaDir, "resources.json"), "utf8"));
    expect(resources.resources.map((resource: { name: string }) => resource.name)).toContain("OpenAI key");
    expect(resources.resources.find((resource: { name: string }) => resource.name === "Shared GPU box").usage).toContain(
      "GPU-backed"
    );
    expect(JSON.stringify(resources)).not.toContain("secret");

    const orders = await fs.readFile(path.join(arenaDir, "resource-orders.md"), "utf8");
    expect(orders).toContain("Run GPU-backed benchmark experiments.");
    expect(orders).toContain("Escalation Rule");

    const competition = await fs.readFile(path.join(arenaDir, "competition.md"), "utf8");
    expect(competition).toContain("You are racing");
    expect(competition).toContain("optional tactical context");
    await expect(fs.readFile(path.join(arenaDir, "scoreboard.md"), "utf8")).resolves.toContain("Agent Arena Scoreboard");
    await expect(fs.readFile(path.join(arenaDir, "rival-summary.md"), "utf8")).resolves.toContain("Agent Arena Rival Summary");

    const checkResources = await fs.readFile(path.join(arenaDir, "check-resources.sh"), "utf8");
    expect(checkResources).toContain("OPENAI_API_KEY");
    expect(checkResources).toContain("Shared GPU box");

    const claim = await fs.readFile(agent.claimScript, "utf8");
    expect(claim).toContain("./.arena/check-resources.sh");
    expect(claim).toContain("exec node cli.js claim --run run-1 --agent codex");
  });

  it("tells non-captains to use chat and patch proposals instead of final claims", async () => {
    const state = await makeState();
    const [agent, rival] = state.agents;
    agent.codename = "Ada";
    agent.teamId = "red";
    agent.teamName = "Team Red";
    agent.captainAgentId = "claude";
    agent.isCaptain = false;
    agent.teamResources = [];
    state.teams = [
      {
        id: "red",
        name: "Team Red",
        captainAgentId: "claude",
        agentIds: ["codex", "claude"],
        resources: []
      }
    ];

    await writeAgentBrief(agent, [rival], state);

    const goal = await fs.readFile(agent.goalFile, "utf8");
    const brief = await fs.readFile(agent.briefFile, "utf8");
    const claim = await fs.readFile(agent.claimScript, "utf8");

    expect(goal).toContain("Only the team captain submits final claims in this run.");
    expect(goal).toContain("./.arena/propose-patch.sh");
    expect(brief).toContain("Send team chat updates or propose patches for claude");
    expect(brief).not.toContain("Submit a finish claim when ready");
    expect(claim).toContain("Only the team captain (claude) can submit final claims for Team Red.");
    expect(claim).toContain("./.arena/chat.sh team");
    expect(claim).not.toContain("exec node cli.js claim");
  });
});
