import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sendPendingChatReminders } from "./chat.js";
import { sendPeriodicCompetitionNotices, updateCompetitionArtifacts } from "./competition.js";
import { refreshAllMirrors } from "./mirror.js";
import { readRunState, resolveStatePath, withRunLock, writeRunState } from "./run-state.js";
import { shellQuote } from "./shell.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function spawnMirrorDaemon(runId: string, statePath: string, cliPath: string, logPath: string): number | undefined {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.openSync(logPath, "a");
  const command = `${shellQuote(process.execPath)} ${shellQuote(cliPath)} mirror-daemon --run ${shellQuote(runId)} --state ${shellQuote(statePath)}`;
  const child = spawn("sh", ["-lc", command], {
    detached: true,
    stdio: ["ignore", out, out]
  });

  child.unref();
  return child.pid;
}

export async function runMirrorDaemon(runId: string, explicitStatePath?: string): Promise<void> {
  const statePath = await resolveStatePath(runId, explicitStatePath);

  while (true) {
    const tick = await withRunLock(statePath, async () => {
      const state = await readRunState(statePath);
      await refreshAllMirrors(state);
      await updateCompetitionArtifacts(state);
      sendPeriodicCompetitionNotices(state);
      await sendPendingChatReminders(state);
      await writeRunState(state);
      return {
        status: state.status,
        refreshIntervalSeconds: state.peek.refreshIntervalSeconds
      };
    });

    if (tick.status !== "running") {
      return;
    }

    await sleep(tick.refreshIntervalSeconds * 1000);
  }
}
