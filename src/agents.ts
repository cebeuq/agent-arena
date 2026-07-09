import { agentPresets, resolveAgentCommand } from "./presets.js";
import { detectPresetGoalCapability } from "./launch.js";
import { commandExists, extractCommandBinary } from "./shell.js";
import type { ArenaConfig } from "./types.js";

export function listAgents(): void {
  for (const preset of Object.values(agentPresets)) {
    console.log(`${preset.id}`);
    console.log(`  name: ${preset.displayName}`);
    console.log(`  binary: ${preset.binary}`);
    console.log(`  prompt command: ${preset.promptCommand}`);
    console.log(`  goal command: ${preset.goalCommand ?? "none — runs in prompt mode"}`);
    console.log(`  docs: ${preset.docsUrl}`);
    console.log(`  install: ${preset.installHint}`);
    console.log("");
  }
}

export function doctorAgents(config?: ArenaConfig): boolean {
  const checks = config
    ? config.agents.map((agent) => {
        const command = resolveAgentCommand(agent);
        return {
          id: agent.id,
          binary: agent.preset ? agentPresets[agent.preset].binary : extractCommandBinary(command) ?? command
        };
      })
    : Object.values(agentPresets).map((preset) => ({
        id: preset.id,
        binary: preset.binary
      }));

  let allFound = true;
  for (const check of checks) {
    const found = commandExists(check.binary);
    allFound &&= found;
    console.log(`${found ? "ok" : "missing"} ${check.id}: ${check.binary}`);

    const configuredAgent = config?.agents.find((agent) => agent.id === check.id);
    if (configuredAgent?.preset) {
      const goal = detectPresetGoalCapability(configuredAgent.preset);
      const goalFound = goal.supported || configuredAgent.goalMode !== "goal";
      allFound &&= goalFound;
      const version = goal.detectedVersion ? ` (${goal.detectedVersion})` : "";
      console.log(`  goal: ${goal.supported ? `supported${version}` : goal.reason}`);
      if (!goal.supported && goal.detectionFailed) {
        console.log(
          `  warning: could not detect the ${check.binary} version, so goal support is unknown. Auto mode will use prompt mode; set goalMode: "goal" to force /goal.`
        );
      }
    }
  }

  return allFound;
}
