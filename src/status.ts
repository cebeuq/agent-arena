import { readRunState, resolveLatestLocalStatePath, resolveStatePath } from "./run-state.js";
import { collectAgentProgress } from "./competition.js";
import {
  describeAvailability,
  describeResource,
  hasResourceUsageDirective,
  readSecretsEnv,
  resolveResourcesAvailability
} from "./resources.js";

export async function printStatus(runId?: string, statePath?: string, json = false): Promise<void> {
  const resolved = runId ? await resolveStatePath(runId, statePath) : statePath ? await resolveStatePath("", statePath) : await resolveLatestLocalStatePath();
  const state = await readRunState(resolved);

  if (json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  console.log(`Run: ${state.runId}`);
  console.log(`Status: ${state.status}`);
  console.log(`Goal: ${state.goal}`);
  console.log(`Judging: ${state.judging.mode}`);
  if (state.judging.mode === "verifier") {
    console.log(`Verifier: ${state.judging.verifyCommand}`);
  }
  console.log(`Director updated: ${state.competitionStatus?.lastDirectorUpdate ?? "never"}`);
  console.log(`Last notice: ${state.competitionStatus?.lastNoticeAt ?? "never"}`);
  console.log(`State: ${state.statePath}`);
  console.log(`tmux: ${state.tmux.sessionName}`);
  console.log("");
  console.log("Shared resources:");
  const savedSecrets = readSecretsEnv(state.arenaRoot);
  const sharedAvailability = resolveResourcesAvailability(state.resources, {
    savedSecrets,
    baseDir: state.baseRepo
  });
  if (sharedAvailability.length === 0) {
    console.log("- none");
  } else {
    for (const availability of sharedAvailability) {
      console.log(`- ${describeResource(availability.resource)} [${describeAvailability(availability)}]`);
      console.log(`  order: ${hasResourceUsageDirective(availability.resource) ? "specified" : "missing usage/trigger"}`);
    }
  }
  console.log("");
  console.log("Teams:");
  if (!state.teams || state.teams.length === 0) {
    console.log("- none");
  } else {
    for (const team of state.teams) {
      const captain = state.agents.find((agent) => agent.id === team.captainAgentId);
      const members = team.agentIds
        .map((agentId) => {
          const member = state.agents.find((agent) => agent.id === agentId);
          return member ? `${member.codename ?? member.name} (${member.id})` : agentId;
        })
        .join(", ");
      console.log(`- ${team.name} (${team.id})`);
      console.log(`  captain: ${captain ? `${captain.codename ?? captain.name} (${captain.id})` : team.captainAgentId}`);
      console.log(`  members: ${members || "none"}`);
      const teamAvailability = resolveResourcesAvailability(team.resources, {
        savedSecrets,
        baseDir: state.baseRepo
      });
      if (teamAvailability.length > 0) {
        console.log("  resources:");
        for (const availability of teamAvailability) {
          console.log(`    - ${describeResource(availability.resource)} [${describeAvailability(availability)}]`);
          console.log(`      order: ${hasResourceUsageDirective(availability.resource) ? "specified" : "missing usage/trigger"}`);
        }
      }
    }
  }
  console.log("");
  console.log("Agents:");
  const progress = new Map(collectAgentProgress(state).map((item) => [item.agentId, item]));
  for (const agent of state.agents) {
    const agentProgress = progress.get(agent.id);
    console.log(`- ${agent.codename ?? agent.name} (${agent.id}): ${agent.name}`);
    console.log(`  team: ${agent.teamName ?? agent.teamId ?? "solo"}${agent.isCaptain === false ? "" : " captain"}`);
    console.log(`  launch: ${agent.launchMode ?? "prompt"} (configured: ${agent.configuredGoalMode ?? "prompt"})`);
    console.log(`  model: ${agent.model ?? "default"}`);
    console.log(`  thinking: ${agent.thinkingLevel ?? "auto"}`);
    if (agent.launchNote) {
      console.log(`  note: ${agent.launchNote}`);
    }
    console.log(`  workspace: ${agent.workspace}`);
    console.log(`  rivals: ${agent.rivalsDir}`);
    console.log(`  claim: ${agent.claimCommand}`);
    console.log(`  changed files: ${agentProgress?.changedFiles.length ?? 0}`);
    console.log(`  claims: ${agentProgress?.claimCount ?? 0}${agentProgress?.latestClaimStatus ? ` (latest: ${agentProgress.latestClaimStatus})` : ""}`);
    const agentAvailability = resolveResourcesAvailability(agent.resources, {
      savedSecrets,
      agentEnv: agent.env,
      baseDir: agent.workspace
    });
    if (agentAvailability.length > 0) {
      console.log("  resources:");
      for (const availability of agentAvailability) {
        console.log(`    - ${describeResource(availability.resource)} [${describeAvailability(availability)}]`);
        console.log(`      order: ${hasResourceUsageDirective(availability.resource) ? "specified" : "missing usage/trigger"}`);
      }
    }
  }

  console.log("");
  if (state.winner) {
    console.log(`Winner: ${state.winner.agentId} (${state.winner.elapsedMs}ms)`);
    if (state.harvest) {
      console.log(
        state.harvest.merged
          ? `Harvest: merged into ${state.harvest.targetBranch} as ${state.harvest.mergeCommit}`
          : `Harvest: committed to ${state.harvest.branch} (not merged)`
      );
    } else {
      console.log(`Harvest: not yet — run: arena harvest --run ${state.runId}`);
    }
  } else {
    console.log("Winner: none yet");
  }

  console.log("");
  const pendingClaims = state.claims.filter((claim) => claim.status === "pending");
  console.log("Pending claims:");
  if (pendingClaims.length === 0) {
    console.log("- none");
  } else {
    for (const claim of pendingClaims) {
      console.log(`- ${claim.agentId}: pending at ${claim.claimedAt}`);
    }
  }

  console.log("");
  console.log("Claims:");
  if (state.claims.length === 0) {
    console.log("- none");
  } else {
    for (const claim of state.claims) {
      console.log(`- ${claim.agentId}: ${claim.status} at ${claim.verifiedAt ?? claim.claimedAt}`);
    }
  }
}
