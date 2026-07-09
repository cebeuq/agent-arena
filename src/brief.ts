import fs from "node:fs/promises";
import path from "node:path";
import { renderChatArtifacts } from "./chat.js";
import { writeCompetitionFilesForAgent } from "./competition.js";
import { renderProposalArtifacts } from "./proposals.js";
import {
  describeAvailability,
  describeResource,
  readSecretsEnv,
  resourceOrderLines,
  resolveResourcesAvailability,
  resourceManifestEntry
} from "./resources.js";
import { shellQuote } from "./shell.js";
import type { RunAgent, RunState } from "./types.js";

function sectionList(items: string[], fallback: string): string[] {
  if (items.length === 0) {
    return [`- ${fallback}`];
  }

  return items.map((item) => `- ${item}`);
}

function resourceLines(title: string, resources: RunState["resources"], state: RunState, agent: RunAgent): string[] {
  if (resources.length === 0) {
    return [title, "", "- None provided."];
  }

  const savedSecrets = readSecretsEnv(state.arenaRoot);
  return [
    title,
    "",
    ...resolveResourcesAvailability(resources, {
      savedSecrets,
      agentEnv: agent.env,
      baseDir: agent.workspace
    }).map((availability) => `- ${describeResource(availability.resource)} [${describeAvailability(availability)}]`)
  ];
}

function judgingLines(state: RunState, agent: RunAgent): string[] {
  if (agent.isCaptain === false) {
    return [
      "## How To Win",
      "",
      `You are a teammate on **${agent.teamName}**. The team captain is **${agent.captainAgentId}**.`,
      "Only the team captain submits final claims in this run.",
      "",
      "Use team chat and patch proposals to move useful work into the captain workspace:",
      "",
      "```sh",
      "./.arena/chat.sh team \"status or request\"",
      "./.arena/propose-patch.sh \"title\" \"summary\"",
      "```"
    ];
  }

  if (state.judging.mode === "manual") {
    return [
      "## How To Win",
      "",
      "Judging mode: manual user review.",
      "",
      "When you believe your work is ready, submit a finish claim:",
      "",
      "```sh",
      "./.arena/claim.sh",
      "```",
      "",
      "Your claim will be recorded for user review. After claiming, wait for the user to accept or reject the claim.",
      "Rival agents will be notified that you claimed and will continue competing until the user accepts a winner.",
      `Success condition: the user accepts the latest pending claim for team \`${agent.teamId}\` submitted by captain \`${agent.id}\`.`
    ];
  }

  return [
    "## How To Win",
    "",
    "Keep working until this command succeeds in your workspace:",
    "",
    "```sh",
    "./.arena/claim.sh",
    "```",
    "",
    "The claim command invokes Agent Arena and runs the verifier below in this workspace:",
    "",
    "```sh",
    state.judging.verifyCommand,
    "```",
    "",
    `Success condition: the claim command exits 0 and reports team \`${agent.teamId}\` / captain \`${agent.id}\`: passed.`,
    "A failed claim is logged, but the match continues. If your claim fails, inspect the output, fix the issue, and claim again."
  ];
}

export async function writeAgentBrief(
  agent: RunAgent,
  rivals: RunAgent[],
  state: RunState
): Promise<void> {
  await fs.mkdir(path.dirname(agent.briefFile), { recursive: true });
  const arenaDir = path.dirname(agent.goalFile);
  const resourcesFile = path.join(arenaDir, "resources.json");
  const resourceOrdersFile = path.join(arenaDir, "resource-orders.md");
  const checkResourcesScript = path.join(arenaDir, "check-resources.sh");
  const chatScript = path.join(arenaDir, "chat.sh");
  const proposePatchScript = path.join(arenaDir, "propose-patch.sh");
  const applyProposalScript = path.join(arenaDir, "apply-proposal.sh");
  const competitionFile = path.join(arenaDir, "competition.md");
  const scoreboardFile = path.join(arenaDir, "scoreboard.md");
  const rivalSummaryFile = path.join(arenaDir, "rival-summary.md");
  const teamChatFile = path.join(arenaDir, "chat", "team.md");
  const publicChatFile = path.join(arenaDir, "chat", "public.md");
  const inboxFile = path.join(arenaDir, "chat", "inbox.md");
  const dmFile = path.join(arenaDir, "chat", "dms.md");
  const teamProposalsFile = path.join(arenaDir, "proposals", "team.md");
  const proposalInboxFile = path.join(arenaDir, "proposals", "inbox.md");

  const codename = agent.codename ?? agent.name ?? agent.id;
  const teamId = agent.teamId ?? agent.id;
  const teamName = agent.teamName ?? agent.name ?? agent.id;
  const captainAgentId = agent.captainAgentId ?? agent.id;
  const isCaptain = agent.isCaptain !== false;

  const goalContract = [
    "# Agent Arena Goal",
    "",
    `You are **${codename} (${agent.id})**, running as **${agent.name}** in run **${state.runId}**.`,
    `You are on **${teamName} (${teamId})**. ${isCaptain ? "You are the team captain and final claim owner." : `Your team captain is ${captainAgentId}.`}`,
    "You are racing other teams while collaborating with your teammates.",
    "",
    "## Harness Settings",
    "",
    `- Model: ${agent.model ?? "default"}`,
    `- Thinking level: ${agent.thinkingLevel ?? "auto"}`,
    `- Launch mode: ${agent.launchMode}`,
    `- Codename: ${codename}`,
    `- Team: ${teamName} (${teamId})`,
    `- Captain: ${captainAgentId}`,
    agent.launchNote ? `- Launch note: ${agent.launchNote}` : undefined,
    "",
    "## Objective",
    "",
    state.goal,
    "",
    "## Done When",
    "",
    ...sectionList(state.successCriteria, "The user will judge whether the objective is satisfied."),
    "",
    ...judgingLines(state, agent),
    "",
    "## Resource Readiness",
    "",
    "Before doing meaningful work, inspect the resource manifest, read the resource orders, and run the resource preflight:",
    "",
    "```sh",
    "cat .arena/resources.json",
    "cat .arena/resource-orders.md",
    "./.arena/check-resources.sh",
    "```",
    "",
    "If a required resource is missing, stop and report the missing resource instead of ignoring it. Provider-backed resources such as GPU, cloud, SSH, and URL entries are declared for manual/provider-specific use.",
    "If local capabilities are insufficient and a declared resource provides the missing capability, use that resource or explicitly state why it is not needed.",
    "",
    "## Rival Visibility",
    "",
    "Read-only mirrors of rival workspaces are available here:",
    "",
    ...rivals.map((rival) => `- ${rival.name}: ${agent.rivalDirs[rival.id]}`),
    "",
    "Rival mirrors are available, but they are optional tactical context. Inspect them when it would naturally help: if stuck, after a rival claim, before final claim, or to compare approaches. Do not spend time on them if your current path is clearly productive.",
    "Do not try to edit, delete, or damage rival workspace mirrors.",
    "",
    "## Team Collaboration",
    "",
    "Use chat for coordination and patch proposals to move useful work into the captain workspace.",
    "",
    "```sh",
    "./.arena/chat.sh team \"message to teammates\"",
    "./.arena/chat.sh public \"message to all teams\"",
    "./.arena/chat.sh dm <agent-id> \"direct message\"",
    "./.arena/chat.sh inbox",
    "./.arena/chat.sh history",
    "```",
    "",
    isCaptain
      ? "As captain, review teammate proposals and apply useful patches with `./.arena/apply-proposal.sh <proposal-id>`."
      : "As a teammate, propose useful code changes with `./.arena/propose-patch.sh \"title\" \"summary\"`. The captain decides what enters the final claim workspace.",
    "",
    "Chat locations:",
    "",
    `- Team chat: ${teamChatFile}`,
    `- Public chat: ${publicChatFile}`,
    `- Inbox: ${inboxFile}`,
    `- DMs: ${dmFile}`,
    `- Team proposals: ${teamProposalsFile}`,
    `- Proposal inbox: ${proposalInboxFile}`,
    "",
    "## Competition Files",
    "",
    `- Competition guide: ${competitionFile}`,
    `- Scoreboard: ${scoreboardFile}`,
    `- Rival summary: ${rivalSummaryFile}`,
    "",
    "## Constraints",
    "",
    "- Keep changes scoped to the objective.",
    "- Do not edit files under `.arena/` except by running the provided claim command.",
    "- Treat `.arena/rivals/` as read-only reference material.",
    "- Preserve output correctness while satisfying the measurable goal.",
    "- Keep a short progress trail in your own responses or notes so the goal evaluator can see what was verified.",
    "",
    ...resourceLines("## Shared Resources", state.resources, state, agent),
    "",
    ...resourceLines("## Team Resources", agent.teamResources ?? [], state, agent),
    "",
    ...resourceLines("## Agent-Specific Resources", agent.resources, state, agent),
    "",
    "## Team-Specific Instructions",
    "",
    agent.teamInstructions?.trim() || "None.",
    "",
    "## Agent-Specific Instructions",
    "",
    agent.instructions?.trim() || "None.",
    "",
    "## Local Files",
    "",
    `- Goal contract: ${agent.goalFile}`,
    `- Brief file: ${agent.briefFile}`,
    `- Resource manifest: ${resourcesFile}`,
    `- Resource orders: ${resourceOrdersFile}`,
    `- Resource check: ${checkResourcesScript}`,
    `- Chat script: ${chatScript}`,
    `- Patch proposal script: ${proposePatchScript}`,
    `- Apply proposal script: ${applyProposalScript}`,
    `- Competition guide: ${competitionFile}`,
    `- Scoreboard: ${scoreboardFile}`,
    `- Rival summary: ${rivalSummaryFile}`,
    `- Claim script: ${agent.claimScript}`,
    `- Rivals directory: ${agent.rivalsDir}`,
    ""
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  const brief = [
    "# Agent Arena Brief",
    "",
    `You are **${codename} (${agent.id})** on **${teamName} (${teamId})** in run **${state.runId}**.`,
    "",
    "Read the full task contract here:",
    "",
    "```sh",
    "cat .arena/goal.md",
    "```",
    "",
    "## How To Win",
    "",
    agent.isCaptain === false
      ? `You are not the captain. Send team chat updates or propose patches for ${agent.captainAgentId}; only the captain submits final claims.`
      : state.judging.mode === "manual"
        ? "Submit a finish claim when ready, then wait for user review:"
        : "Keep working until this command succeeds:",
    "",
    ...(agent.isCaptain === false
      ? [
          "```sh",
          "./.arena/chat.sh team \"status or handoff\"",
          "./.arena/propose-patch.sh \"title\" \"summary\"",
          "```"
        ]
      : [
          "```sh",
          "./.arena/claim.sh",
          "```"
        ]),
    "",
    agent.isCaptain === false
      ? "Use chat and proposals to move useful work into the captain workspace."
      : state.judging.mode === "manual"
        ? "Manual claims stay pending until the user accepts a winner. Rival agents are notified when a claim is submitted."
        : "The first captain claim whose verifier passes wins automatically. Failed claims are logged and the run continues.",
    "",
    `Model: ${agent.model ?? "default"}`,
    `Thinking level: ${agent.thinkingLevel ?? "auto"}`,
    `Launch mode: ${agent.launchMode}`,
    `Captain: ${captainAgentId}`,
    agent.launchNote ? `Launch note: ${agent.launchNote}` : undefined,
    "",
    "Resource check:",
    "",
    "```sh",
    "cat .arena/resource-orders.md",
    "./.arena/check-resources.sh",
    "```",
    "",
    "Local files:",
    "",
    `- Goal contract: ${agent.goalFile}`,
    `- Resource manifest: ${resourcesFile}`,
    `- Resource orders: ${resourceOrdersFile}`,
    `- Resource check: ${checkResourcesScript}`,
    `- Chat script: ${chatScript}`,
    `- Team chat: ${teamChatFile}`,
    `- Inbox: ${inboxFile}`,
    `- Proposals: ${teamProposalsFile}`,
    `- Competition guide: ${competitionFile}`,
    `- Scoreboard: ${scoreboardFile}`,
    `- Rival summary: ${rivalSummaryFile}`,
    `- Rivals directory: ${agent.rivalsDir}`,
    `- Claim script: ${agent.claimScript}`,
    ""
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  await fs.writeFile(agent.goalFile, `${goalContract}\n`, "utf8");
  await fs.writeFile(agent.briefFile, brief, "utf8");
  await writeResourceFiles(resourcesFile, resourceOrdersFile, checkResourcesScript, agent, state);
  await writeCompetitionFilesForAgent(state, agent);
  await writeChatScripts(agent);
  await writeProposalScripts(agent);
  await renderChatArtifacts(state);
  await renderProposalArtifacts(state);
  await fs.writeFile(
    agent.claimScript,
    agent.isCaptain !== false
      ? `#!/usr/bin/env sh\nset -eu\n./.arena/check-resources.sh\nexec ${agent.claimCommand}\n`
      : [
          "#!/usr/bin/env sh",
          "set -eu",
          `echo ${shellQuote(`Only the team captain (${agent.captainAgentId}) can submit final claims for ${agent.teamName}.`)} >&2`,
          "echo 'Use ./.arena/chat.sh team \"status\" or ./.arena/propose-patch.sh \"title\" \"summary\".' >&2",
          "exit 1",
          ""
        ].join("\n"),
    {
      encoding: "utf8",
      mode: 0o755
    }
  );
}

async function writeChatScripts(agent: RunAgent): Promise<void> {
  const arenaDir = path.dirname(agent.goalFile);
  const chatScript = agent.chatScript ?? path.join(arenaDir, "chat.sh");
  const chatCommand = agent.chatCommand ?? "echo 'chat command unavailable' >&2; exit 1";
  const chatInboxCommand = agent.chatInboxCommand ?? "echo 'chat inbox unavailable' >&2; exit 1";
  const chatHistoryCommand = agent.chatHistoryCommand ?? "echo 'chat history unavailable' >&2; exit 1";
  const script = [
    "#!/usr/bin/env sh",
    "set -eu",
    "cmd=${1:-}",
    "if [ $# -gt 0 ]; then shift; fi",
    "case \"$cmd\" in",
    "  team)",
    "    [ $# -gt 0 ] || { echo 'usage: ./.arena/chat.sh team \"message\"' >&2; exit 2; }",
    `    exec ${chatCommand} --scope team --message "$*"`,
    "    ;;",
    "  public)",
    "    [ $# -gt 0 ] || { echo 'usage: ./.arena/chat.sh public \"message\"' >&2; exit 2; }",
    `    exec ${chatCommand} --scope public --message "$*"`,
    "    ;;",
    "  dm)",
    "    [ $# -ge 2 ] || { echo 'usage: ./.arena/chat.sh dm <agent-id> \"message\"' >&2; exit 2; }",
    "    target=$1",
    "    shift",
    `    exec ${chatCommand} --scope dm --to "$target" --message "$*"`,
    "    ;;",
    "  inbox)",
    `    exec ${chatInboxCommand}`,
    "    ;;",
    "  history)",
    `    exec ${chatHistoryCommand}`,
    "    ;;",
    "  *)",
    "    echo 'usage: ./.arena/chat.sh team|public|dm|inbox|history ...' >&2",
    "    exit 2",
    "    ;;",
    "esac",
    ""
  ].join("\n");
  await fs.writeFile(chatScript, script, {
    encoding: "utf8",
    mode: 0o755
  });
}

async function writeProposalScripts(agent: RunAgent): Promise<void> {
  const arenaDir = path.dirname(agent.goalFile);
  const proposePatchScript = agent.proposePatchScript ?? path.join(arenaDir, "propose-patch.sh");
  const applyProposalScript = agent.applyProposalScript ?? path.join(arenaDir, "apply-proposal.sh");
  const proposePatchCommand = agent.proposePatchCommand ?? "echo 'proposal command unavailable' >&2; exit 1";
  const applyProposalCommand = agent.applyProposalCommand ?? "echo 'apply proposal command unavailable' >&2; exit 1";
  const propose = [
    "#!/usr/bin/env sh",
    "set -eu",
    "[ $# -ge 2 ] || { echo 'usage: ./.arena/propose-patch.sh \"title\" \"summary\"' >&2; exit 2; }",
    "title=$1",
    "shift",
    `exec ${proposePatchCommand} --title "$title" --summary "$*"`,
    ""
  ].join("\n");
  await fs.writeFile(proposePatchScript, propose, {
    encoding: "utf8",
    mode: 0o755
  });

  const apply = agent.isCaptain !== false
    ? [
        "#!/usr/bin/env sh",
        "set -eu",
        "[ $# -eq 1 ] || { echo 'usage: ./.arena/apply-proposal.sh <proposal-id>' >&2; exit 2; }",
        `exec ${applyProposalCommand} --proposal "$1"`,
        ""
      ].join("\n")
    : [
        "#!/usr/bin/env sh",
        "set -eu",
        `echo ${shellQuote(`Only team captain ${agent.captainAgentId} can apply proposals for ${agent.teamName}.`)} >&2`,
        "exit 1",
        ""
      ].join("\n");
  await fs.writeFile(applyProposalScript, apply, {
    encoding: "utf8",
    mode: 0o755
  });
}

function checkLineForResource(resource: RunState["resources"][number], scope: "shared" | "team" | "agent"): string[] {
  const label = `${scope} resource "${resource.name}"`;
  const optional = Boolean(resource.optional);
  const echo = (message: string): string => `echo ${shellQuote(message)}`;
  const echoErr = (message: string): string => `echo ${shellQuote(message)} >&2`;

  if (resource.type === "env" && resource.envVar) {
    const envVar = resource.envVar;
    return optional
      ? [
          `if [ -z "\${${envVar}+x}" ] || [ -z "\${${envVar}}" ]; then`,
          `  ${echo(`optional env ${envVar} missing for ${label}`)}`,
          "else",
          `  ${echo(`ok env ${envVar} for ${label}`)}`,
          "fi"
        ]
      : [
          `if [ -z "\${${envVar}+x}" ] || [ -z "\${${envVar}}" ]; then`,
          `  ${echoErr(`missing required env ${envVar} for ${label}`)}`,
          "  missing=1",
          "else",
          `  ${echo(`ok env ${envVar} for ${label}`)}`,
          "fi"
        ];
  }

  if ((resource.type === "file" || resource.type === "dataset") && resource.path) {
    const quotedPath = shellQuote(resource.path);
    return optional
      ? [
          `if [ ! -e ${quotedPath} ]; then`,
          `  ${echo(`optional path ${resource.path} missing for ${label}`)}`,
          "else",
          `  ${echo(`ok path ${resource.path} for ${label}`)}`,
          "fi"
        ]
      : [
          `if [ ! -e ${quotedPath} ]; then`,
          `  ${echoErr(`missing required path ${resource.path} for ${label}`)}`,
          "  missing=1",
          "else",
          `  ${echo(`ok path ${resource.path} for ${label}`)}`,
          "fi"
        ];
  }

  return [echo(`declared ${resource.type} ${label}; manual/provider-specific check may be required`)];
}

async function writeResourceFiles(
  resourcesFile: string,
  resourceOrdersFile: string,
  checkResourcesScript: string,
  agent: RunAgent,
  state: RunState
): Promise<void> {
  const savedSecrets = readSecretsEnv(state.arenaRoot);
  const sharedAvailability = resolveResourcesAvailability(state.resources, {
    savedSecrets,
    agentEnv: agent.env,
    baseDir: agent.workspace
  });
  const agentAvailability = resolveResourcesAvailability(agent.resources, {
    savedSecrets,
    agentEnv: agent.env,
    baseDir: agent.workspace
  });
  const manifest = {
    generatedAt: new Date().toISOString(),
    agentId: agent.id,
    runId: state.runId,
    note: "Secret values are redacted. Env resources are injected into the agent process when available.",
    resources: [
      ...sharedAvailability.map((availability) => resourceManifestEntry(availability, "shared")),
      ...resolveResourcesAvailability(agent.teamResources ?? [], {
        savedSecrets,
        agentEnv: agent.env,
        baseDir: agent.workspace
      }).map((availability) => resourceManifestEntry(availability, "team")),
      ...agentAvailability.map((availability) => resourceManifestEntry(availability, "agent"))
    ]
  };
  const resourceOrders = [
    "# Agent Arena Resource Orders",
    "",
    "These orders explain when and how to use declared resources. Secret values are never shown here.",
    "",
    "## Escalation Rule",
    "",
    "If the task needs a capability that the local workspace lacks, and a declared resource provides that capability, use the resource or explicitly record why it is not needed.",
    "",
    "## Shared Resources",
    "",
    ...(state.resources.length > 0 ? state.resources.flatMap((resource) => resourceOrderLines(resource)) : ["- None.", ""]),
    "## Team Resources",
    "",
    ...((agent.teamResources ?? []).length > 0 ? (agent.teamResources ?? []).flatMap((resource) => resourceOrderLines(resource)) : ["- None.", ""]),
    "## Agent-Specific Resources",
    "",
    ...(agent.resources.length > 0 ? agent.resources.flatMap((resource) => resourceOrderLines(resource)) : ["- None.", ""])
  ].join("\n");

  const script = [
    "#!/usr/bin/env sh",
    "set -u",
    "missing=0",
    "echo \"Checking Agent Arena resources...\"",
    ...state.resources.flatMap((resource) => checkLineForResource(resource, "shared")),
    ...(agent.teamResources ?? []).flatMap((resource) => checkLineForResource(resource, "team")),
    ...agent.resources.flatMap((resource) => checkLineForResource(resource, "agent")),
    "if [ \"$missing\" -ne 0 ]; then",
    "  echo \"One or more required Agent Arena resources are missing.\" >&2",
    "  exit 1",
    "fi",
    "echo \"Agent Arena resource check complete.\"",
    ""
  ].join("\n");

  await fs.writeFile(resourcesFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.writeFile(resourceOrdersFile, `${resourceOrders}\n`, "utf8");
  await fs.writeFile(checkResourcesScript, script, {
    encoding: "utf8",
    mode: 0o755
  });
}
