#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Command } from "commander";
import { listAgents, doctorAgents } from "./agents.js";
import { chatHistory, readInbox, sendChatMessage, type ChatScope } from "./chat.js";
import { acceptManualClaim, claimRun, rejectManualClaim } from "./claim.js";
import { sendManualPressureNotice, updateCompetitionArtifacts } from "./competition.js";
import { readConfig } from "./config.js";
import { runMirrorDaemon } from "./daemon.js";
import { harvestRun } from "./harvest.js";
import { initConfig } from "./init.js";
import { cleanRuns, formatRunsTable, listRuns, stopRun } from "./lifecycle.js";
import { applyProposal, createProposal, proposalHistory } from "./proposals.js";
import { refreshAllMirrors } from "./mirror.js";
import { readRunState, resolveStatePath, withRunLock, writeRunState } from "./run-state.js";
import { renderSetupDraftPreview, type SetupDraftPreviewView } from "./setup.js";
import { startArena } from "./start.js";
import { printStatus } from "./status.js";
import { attachTmux } from "./tmux.js";
import { runArenaTui } from "./tui/index.js";
import { runLaunchAndOverseer, runOverseer } from "./tui/overseer/index.js";
import type { TerminalAttachMode } from "./terminal.js";

const cliPath = fileURLToPath(import.meta.url);
process.env.AGENT_ARENA_CLI_PATH = cliPath;
const invokedName = path.basename(process.argv[1] ?? "agent-arena");

const program = new Command();

program
  .name(invokedName)
  .description("Run competitive coding-agent matches in isolated git worktrees.")
  .version("0.1.0");

program
  .command("init")
  .description("Create an arena.config.json file.")
  .option("-o, --output <path>", "Config path to write.", "arena.config.json")
  .option("--force", "Overwrite an existing config.", false)
  .action(async (options: { output: string; force: boolean }) => {
    await initConfig(options.output, options.force);
  });

const agents = program.command("agents").description("Inspect supported agent presets.");

agents.command("list").description("List built-in agent presets.").action(() => {
  listAgents();
});

agents
  .command("doctor")
  .description("Check whether configured agent binaries are installed.")
  .option("-c, --config <path>", "Config path to check.")
  .action(async (options: { config?: string }) => {
    const config = options.config ? await readConfig(options.config) : undefined;
    const ok = doctorAgents(config);
    process.exitCode = ok ? 0 : 1;
  });

program
  .command("start")
  .description("Start a competitive agent run.")
  .requiredOption("-c, --config <path>", "Arena config path.")
  .option("--no-attach", "Create the tmux session without attaching.")
  .option("--no-tui", "Skip the launch/overseer TUI; print console output and attach tmux.")
  .option("--terminal <mode>", "Attach mode: auto, current, external, or print.", "auto")
  .action(async (options: { config: string; attach: boolean; tui: boolean; terminal: TerminalAttachMode }) => {
    const useTui = options.tui && options.attach && Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
    if (useTui) {
      await runLaunchAndOverseer({
        configPath: options.config,
        cliPath,
        terminal: options.terminal
      });
      return;
    }
    await startArena({
      configPath: options.config,
      attach: options.attach,
      terminal: options.terminal,
      cliPath
    });
  });

program
  .command("overseer")
  .description("Open the live run overseer TUI (dashboard, chat, proposals, judging).")
  .option("--run <id>", "Run id. Defaults to the single running local run.")
  .option("--state <path>", "Direct path to state.json.")
  .option("--terminal <mode>", "Terminal mode for opening tmux: auto, external, or print.", "auto")
  .action(async (options: { run?: string; state?: string; terminal: TerminalAttachMode }) => {
    await runOverseer({
      runId: options.run,
      statePath: options.state,
      cliPath,
      terminal: options.terminal
    });
  });

program
  .command("attach")
  .description("Attach to a run's tmux overseer session.")
  .requiredOption("--run <id>", "Run id.")
  .option("--state <path>", "Direct path to state.json.")
  .option("--terminal <mode>", "Attach mode: auto, current, external, or print.", "auto")
  .action(async (options: { run: string; state?: string; terminal: TerminalAttachMode }) => {
    const statePath = await resolveStatePath(options.run, options.state);
    const state = await readRunState(statePath);
    const result = attachTmux(state.tmux.sessionName, options.terminal);
    for (const warning of result.warnings) {
      console.warn(warning);
    }
    process.exitCode = result.attached || result.launchedExternal || result.openedInTmux ? 0 : 1;
  });

program
  .command("claim")
  .description("Claim victory for an agent and run the verifier.")
  .requiredOption("--run <id>", "Run id.")
  .requiredOption("--agent <id>", "Agent id.")
  .option("--state <path>", "Direct path to state.json.")
  .action(async (options: { run: string; agent: string; state?: string }) => {
    const claim = await claimRun({
      runId: options.run,
      agentId: options.agent,
      statePath: options.state
    });
    console.log(`${claim.agentId}: ${claim.status}`);
    if (claim.note) {
      console.log(claim.note);
    }
    if (claim.stdout.trim()) {
      console.log(claim.stdout.trim());
    }
    if (claim.stderr.trim()) {
      console.error(claim.stderr.trim());
    }
    process.exitCode = claim.status === "failed" || claim.status === "ignored" ? 1 : 0;
  });

const runs = program.command("runs").description("Inspect local Agent Arena runs.");

runs
  .command("list")
  .description("List local runs from this repo and the global run index.")
  .action(async () => {
    console.log(formatRunsTable(await listRuns()));
  });

program
  .command("stop")
  .description("Stop a run: kill its tmux session and mirror daemon.")
  .requiredOption("--run <id>", "Run id.")
  .option("--state <path>", "Direct path to state.json.")
  .action(async (options: { run: string; state?: string }) => {
    const result = await stopRun({ runId: options.run, statePath: options.state });
    if (result.alreadyStopped) {
      console.log(`Run ${result.runId} was not running; cleaned up leftovers.`);
    } else {
      console.log(`Stopped run ${result.runId}.`);
    }
    console.log(`tmux session: ${result.tmuxKilled ? "killed" : "already gone"}`);
    console.log(`mirror daemon: ${result.daemonKilled ? "killed" : "already gone"}`);
  });

program
  .command("clean")
  .description("Remove a run's worktrees, workspaces, and run directory.")
  .option("--run <id>", "Run id to clean.")
  .option("--finished", "Clean every non-running local run.", false)
  .option("--force", "Stop a still-running run before cleaning it.", false)
  .option("--branches", "Also delete agent branches (unharvested winner branches are kept).", false)
  .option("--state <path>", "Direct path to state.json.")
  .action(async (options: { run?: string; finished: boolean; force: boolean; branches: boolean; state?: string }) => {
    const cleaned = await cleanRuns({
      runId: options.run,
      statePath: options.state,
      finished: options.finished,
      force: options.force,
      deleteBranches: options.branches
    });
    if (cleaned.length === 0) {
      console.log("Nothing to clean.");
      return;
    }
    for (const run of cleaned) {
      for (const message of run.messages) {
        console.log(message);
      }
    }
  });

program
  .command("status")
  .description("Print run status.")
  .option("--run <id>", "Run id. Defaults to the latest local run.")
  .option("--state <path>", "Direct path to state.json.")
  .option("--json", "Print JSON state.", false)
  .action(async (options: { run?: string; state?: string; json: boolean }) => {
    await printStatus(options.run, options.state, options.json);
  });

program
  .command("pressure")
  .description("Send a one-time competitive notice and refresh competition files.")
  .requiredOption("--run <id>", "Run id.")
  .option("--agent <id>", "Target one agent id.")
  .option("--message <text>", "Custom notice text.")
  .option("--state <path>", "Direct path to state.json.")
  .action(async (options: { run: string; agent?: string; message?: string; state?: string }) => {
    const statePath = await resolveStatePath(options.run, options.state);
    const count = await withRunLock(statePath, async () => {
      const state = await readRunState(statePath);
      await refreshAllMirrors(state);
      await updateCompetitionArtifacts(state);
      const sent = sendManualPressureNotice(state, {
        agentId: options.agent,
        message: options.message
      });
      if (options.agent && sent === 0) {
        throw new Error(`Unknown agent ${options.agent} for run ${options.run}.`);
      }
      await writeRunState(state);
      return sent;
    });
    console.log(`Sent pressure notice to ${count} agent${count === 1 ? "" : "s"}.`);
  });

const chat = program.command("chat").description("Send and inspect Arena team/public/DM chat.");

chat
  .command("send")
  .description("Send a chat message from an agent or the user (--agent user).")
  .requiredOption("--run <id>", "Run id.")
  .requiredOption("--agent <id>", "Sending agent id, or 'user' for the director.")
  .requiredOption("--scope <scope>", "team, public, or dm.")
  .requiredOption("--message <text>", "Message text.")
  .option("--to <agent-id>", "DM recipient agent id.")
  .option("--team <team-id>", "Target team id (required for user team messages).")
  .option("--state <path>", "Direct path to state.json.")
  .action(async (options: { run: string; agent: string; scope: ChatScope; message: string; to?: string; team?: string; state?: string }) => {
    const statePath = await resolveStatePath(options.run, options.state);
    const message = await withRunLock(statePath, async () => {
      const state = await readRunState(statePath);
      const sent = await sendChatMessage(state, {
        fromAgentId: options.agent,
        scope: options.scope,
        toAgentId: options.to,
        teamId: options.team,
        message: options.message
      });
      await writeRunState(state);
      return sent;
    });
    console.log(`${message.scope}: ${message.fromCodename} (${message.fromAgentId}) sent ${message.id}`);
  });

chat
  .command("history")
  .description("Print chat history.")
  .requiredOption("--run <id>", "Run id.")
  .option("--team <id>", "Team id.")
  .option("--public", "Show public chat only.", false)
  .option("--agent <id>", "Show messages visible to one agent.")
  .option("--state <path>", "Direct path to state.json.")
  .action(async (options: { run: string; team?: string; public: boolean; agent?: string; state?: string }) => {
    const statePath = await resolveStatePath(options.run, options.state);
    const state = await readRunState(statePath);
    console.log(await chatHistory(state, {
      teamId: options.team,
      publicOnly: options.public,
      agentId: options.agent
    }));
  });

chat
  .command("inbox")
  .description("Print unread messages for an agent and mark them read.")
  .requiredOption("--run <id>", "Run id.")
  .requiredOption("--agent <id>", "Agent id.")
  .option("--state <path>", "Direct path to state.json.")
  .action(async (options: { run: string; agent: string; state?: string }) => {
    const statePath = await resolveStatePath(options.run, options.state);
    const unread = await withRunLock(statePath, async () => {
      const state = await readRunState(statePath);
      const messages = await readInbox(state, options.agent);
      await writeRunState(state);
      return messages;
    });
    if (unread.length === 0) {
      console.log("No unread messages.");
      return;
    }
    for (const message of unread) {
      console.log(`${message.createdAt} ${message.fromCodename} (${message.fromAgentId}) [${message.scope}]: ${message.message}`);
    }
  });

const proposal = program.command("proposal").description("Create and apply team patch proposals.");

proposal
  .command("create")
  .description("Create a patch proposal from an agent workspace.")
  .requiredOption("--run <id>", "Run id.")
  .requiredOption("--agent <id>", "Agent id.")
  .requiredOption("--title <text>", "Proposal title.")
  .requiredOption("--summary <text>", "Proposal summary.")
  .option("--state <path>", "Direct path to state.json.")
  .action(async (options: { run: string; agent: string; title: string; summary: string; state?: string }) => {
    const statePath = await resolveStatePath(options.run, options.state);
    const record = await withRunLock(statePath, async () => {
      const state = await readRunState(statePath);
      const created = await createProposal(state, {
        agentId: options.agent,
        title: options.title,
        summary: options.summary
      });
      await writeRunState(state);
      return created;
    });
    console.log(`proposal ${record.id}: ${record.status}`);
  });

proposal
  .command("apply")
  .description("Apply a patch proposal in the captain workspace.")
  .requiredOption("--run <id>", "Run id.")
  .requiredOption("--agent <id>", "Captain agent id.")
  .requiredOption("--proposal <id>", "Proposal id.")
  .option("--state <path>", "Direct path to state.json.")
  .action(async (options: { run: string; agent: string; proposal: string; state?: string }) => {
    const statePath = await resolveStatePath(options.run, options.state);
    const record = await withRunLock(statePath, async () => {
      const state = await readRunState(statePath);
      const applied = await applyProposal(state, {
        agentId: options.agent,
        proposalId: options.proposal
      });
      await writeRunState(state);
      return applied;
    });
    console.log(`proposal ${record.id}: ${record.status}`);
    if (record.statusNote) {
      console.log(record.statusNote);
    }
    process.exitCode = record.status === "failed" ? 1 : 0;
  });

proposal
  .command("history")
  .description("Print proposal history.")
  .requiredOption("--run <id>", "Run id.")
  .option("--team <id>", "Team id.")
  .option("--state <path>", "Direct path to state.json.")
  .action(async (options: { run: string; team?: string; state?: string }) => {
    const statePath = await resolveStatePath(options.run, options.state);
    const state = await readRunState(statePath);
    console.log(await proposalHistory(state, options.team));
  });

const judge = program.command("judge").description("Review and accept manual arena claims.");

judge
  .command("accept")
  .description("Accept an agent's latest pending manual claim and finish the run.")
  .requiredOption("--run <id>", "Run id.")
  .requiredOption("--agent <id>", "Agent id.")
  .option("--state <path>", "Direct path to state.json.")
  .action(async (options: { run: string; agent: string; state?: string }) => {
    const claim = await acceptManualClaim({
      runId: options.run,
      agentId: options.agent,
      statePath: options.state
    });
    console.log(`${claim.agentId}: ${claim.status}`);
    if (claim.note) {
      console.log(claim.note);
    }
  });

program
  .command("harvest")
  .description("Commit the winner's work to its branch and merge it into the base repo.")
  .requiredOption("--run <id>", "Run id.")
  .option("--no-merge", "Only commit to the winner's branch; skip merging into the base repo.")
  .option("--state <path>", "Direct path to state.json.")
  .action(async (options: { run: string; merge: boolean; state?: string }) => {
    const result = await harvestRun({
      runId: options.run,
      merge: options.merge,
      statePath: options.state
    });
    for (const message of result.messages) {
      console.log(message);
    }
  });

judge
  .command("reject")
  .description("Reject an agent's latest pending manual claim; the run continues.")
  .requiredOption("--run <id>", "Run id.")
  .requiredOption("--agent <id>", "Agent id.")
  .option("--note <text>", "Reason shown to the claiming agent.")
  .option("--state <path>", "Direct path to state.json.")
  .action(async (options: { run: string; agent: string; note?: string; state?: string }) => {
    const claim = await rejectManualClaim({
      runId: options.run,
      agentId: options.agent,
      statePath: options.state,
      note: options.note
    });
    console.log(`${claim.agentId}: ${claim.status}`);
    if (claim.note) {
      console.log(claim.note);
    }
  });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clearTerminal(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

async function runDisplayLoop(renderText: () => Promise<string>, intervalMs = 2000): Promise<void> {
  while (true) {
    clearTerminal();
    try {
      process.stdout.write(await renderText());
    } catch (error) {
      process.stdout.write(`Agent Arena pane error: ${(error as Error).message}\n`);
    }
    await sleep(intervalMs);
  }
}

function renderTeamSidebar(state: Awaited<ReturnType<typeof readRunState>>, teamId: string): string {
  const selectedTeam = state.teams?.find((team) => team.id === teamId);
  const pendingClaim = state.claims
    .filter((claim) => claim.teamId === teamId && claim.status === "pending")
    .at(-1);
  const lines = [
    "AGENT ARENA OVERSEER",
    "",
    `Run: ${state.runId}`,
    `Status: ${state.status}`,
    `Judging: ${state.judging.mode}`,
    `Team: ${selectedTeam?.name ?? teamId}`,
    ""
  ];

  if (pendingClaim) {
    const claimant = state.agents.find((agent) => agent.id === pendingClaim.agentId);
    lines.push("FINISH CLAIM SUBMITTED", `${claimant?.codename ?? claimant?.name ?? pendingClaim.agentId} says this team is done.`, "");
    lines.push(`Accept: arena judge accept --run ${state.runId} --agent ${pendingClaim.agentId}`);
    lines.push("Keep Running: ignore this banner and let the teams continue.", "");
  }

  lines.push("Teams:");
  for (const team of state.teams ?? []) {
    const marker = team.id === teamId ? ">" : " ";
    const captain = state.agents.find((agent) => agent.id === team.captainAgentId);
    lines.push(`${marker} ${team.name}`);
    lines.push(`  captain: ${captain?.codename ?? captain?.name ?? team.captainAgentId}`);
    lines.push(`  agents: ${team.agentIds.length}`);
  }

  lines.push("", "Selected team agents:");
  for (const agent of state.agents.filter((agent) => agent.teamId === teamId)) {
    lines.push(`- ${agent.codename ?? agent.name} (${agent.id})${agent.isCaptain ? " CAPTAIN" : ""}`);
    lines.push(`  ${agent.preset ?? "custom"} / ${agent.launchMode ?? "prompt"} / ${agent.thinkingLevel ?? "auto"}`);
  }

  lines.push("", "Switch teams with tmux windows: Ctrl-b n / Ctrl-b p.");
  lines.push("Full dashboard, chat, and judging: arena overseer");
  return `${lines.join("\n")}\n`;
}

const tui = program.command("tui", { hidden: true }).description("Internal Agent Arena TUI pane helpers.");

tui
  .command("draft-watch", { hidden: true })
  .requiredOption("--repo <path>", "Repository path.")
  .option("--view <view>", "contract or json.", "contract")
  .action(async (options: { repo: string; view: SetupDraftPreviewView }) => {
    let view: SetupDraftPreviewView = options.view === "json" ? "json" : "contract";
    let scroll = 0;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", (buffer) => {
        const key = buffer.toString("utf8");
        if (key === "v") {
          view = view === "contract" ? "json" : "contract";
          scroll = 0;
        } else if (key === "j" || key === "\u001b[B") {
          scroll += 1;
        } else if (key === "k" || key === "\u001b[A") {
          scroll = Math.max(0, scroll - 1);
        } else if (key === "\u001b[6~") {
          scroll += 12;
        } else if (key === "\u001b[5~") {
          scroll = Math.max(0, scroll - 12);
        } else if (key === "\u0003") {
          process.exit(0);
        }
      });
    }
    await runDisplayLoop(async () => {
      const preview = await renderSetupDraftPreview(options.repo, view);
      const height = Math.max(8, (process.stdout.rows ?? 36) - 4);
      const lines = preview.split("\n");
      scroll = Math.min(scroll, Math.max(0, lines.length - height));
      return `View: ${view}  Scroll: ${scroll}/${Math.max(0, lines.length - height)}  (v toggle, j/k scroll, PgUp/PgDn)\n\n${lines
        .slice(scroll, scroll + height)
        .join("\n")}\n`;
    }, 1000);
  });

tui
  .command("team-sidebar", { hidden: true })
  .requiredOption("--run <id>", "Run id.")
  .requiredOption("--state <path>", "Direct path to state.json.")
  .requiredOption("--team <id>", "Team id.")
  .action(async (options: { run: string; state: string; team: string }) => {
    await runDisplayLoop(async () => {
      const state = await readRunState(options.state);
      return renderTeamSidebar(state, options.team);
    }, 2000);
  });

program
  .command("mirror-daemon", { hidden: true })
  .requiredOption("--run <id>", "Run id.")
  .option("--state <path>", "Direct path to state.json.")
  .action(async (options: { run: string; state?: string }) => {
    await runMirrorDaemon(options.run, options.state);
  });

const args = process.argv.slice(2);

(invokedName === "arena" && args.length === 0 ? runArenaTui({ cliPath }) : program.parseAsync()).catch(
  (error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  }
);
