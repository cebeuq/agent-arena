import { spawnSync } from "node:child_process";
import { shellQuote } from "./shell.js";

export type TerminalAttachMode = "auto" | "current" | "external" | "print";

export type TerminalCheck = {
  ok: boolean;
  reasons: string[];
};

export type AttachResult = {
  attached: boolean;
  launchedExternal: boolean;
  // The session was opened as a window/pane of the tmux session the user is
  // already inside (nested attach) instead of an external terminal app.
  openedInTmux?: boolean;
  command: string;
  warnings: string[];
};

export type TerminalRuntime = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  stdoutIsTTY?: boolean;
  stdinIsTTY?: boolean;
  spawn?: typeof spawnSync;
  commandExists?: (binary: string) => boolean;
};

function runtimeSpawn(runtime: TerminalRuntime): typeof spawnSync {
  return runtime.spawn ?? spawnSync;
}

function runtimeEnv(runtime: TerminalRuntime): NodeJS.ProcessEnv {
  return runtime.env ?? process.env;
}

function exists(binary: string, runtime: TerminalRuntime): boolean {
  if (runtime.commandExists) {
    return runtime.commandExists(binary);
  }
  const result = runtimeSpawn(runtime)("sh", ["-lc", `command -v ${shellQuote(binary)}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000
  });
  return result.status === 0;
}

export function tmuxAttachCommand(sessionName: string): string {
  return `tmux attach-session -t ${shellQuote(sessionName)}`;
}

export function checkCurrentTerminal(runtime: TerminalRuntime = {}): TerminalCheck {
  const env = runtimeEnv(runtime);
  const reasons: string[] = [];
  const stdoutIsTTY = runtime.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  const stdinIsTTY = runtime.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const term = env.TERM ?? "";

  if (!stdoutIsTTY || !stdinIsTTY) {
    reasons.push("current process is not attached to an interactive TTY");
  }
  if (!term || term === "dumb") {
    reasons.push(`TERM is ${term || "unset"}`);
  }
  if (env.TMUX) {
    reasons.push("already inside tmux; attach from a parent terminal or use a separate terminal window");
  }

  if (term && term !== "dumb") {
    const result = runtimeSpawn(runtime)("sh", ["-lc", "infocmp \"$TERM\" | grep -q 'clear='"], {
      env: {
        ...env,
        TERM: term
      },
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"]
    });
    if (result.status !== 0) {
      reasons.push(`terminal ${term} does not advertise a clear capability`);
    }
  }

  return {
    ok: reasons.length === 0,
    reasons
  };
}

function macExternalCommands(command: string): string[] {
  const escaped = command.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return [
    `osascript -e ${shellQuote(`tell application "Terminal" to activate`)} -e ${shellQuote(
      `tell application "Terminal" to do script "${escaped}"`
    )}`,
    `osascript -e ${shellQuote(`tell application "iTerm" to activate`)} -e ${shellQuote(
      `tell application "iTerm" to create window with default profile command "${escaped}"`
    )}`
  ];
}

function linuxExternalCommands(command: string, runtime: TerminalRuntime): string[] {
  const candidates = [
    ["x-terminal-emulator", ["-e", command]],
    ["gnome-terminal", ["--", "sh", "-lc", command]],
    ["konsole", ["-e", "sh", "-lc", command]],
    ["kitty", ["sh", "-lc", command]],
    ["wezterm", ["start", "--", "sh", "-lc", command]],
    ["alacritty", ["-e", "sh", "-lc", command]]
  ] as const;

  return candidates
    .filter(([binary]) => exists(binary, runtime))
    .map(([binary, args]) => [binary, ...args.map((arg) => shellQuote(arg))].join(" "));
}

export function externalAttachCommands(sessionName: string, runtime: TerminalRuntime = {}): string[] {
  const command = tmuxAttachCommand(sessionName);
  const platform = runtime.platform ?? process.platform;
  const env = runtime.env ?? process.env;
  // Over SSH a GUI terminal would open on the remote machine's physical
  // display, invisible to the user — treat external launch as unavailable so
  // callers fall back to attaching in the current terminal.
  if (env.SSH_TTY || env.SSH_CONNECTION) {
    return [];
  }
  if (platform === "darwin" && exists("osascript", runtime)) {
    return macExternalCommands(command);
  }
  if (platform === "linux") {
    return linuxExternalCommands(command, runtime);
  }
  return [];
}

function runShell(command: string, runtime: TerminalRuntime): number | null {
  // Timeout guards against launchers that block on permission prompts (for
  // example osascript waiting for macOS automation approval); a hung spawnSync
  // would freeze the whole event loop. A timeout reports status null and must
  // be treated as failure by callers.
  const result = runtimeSpawn(runtime)("sh", ["-lc", command], {
    stdio: "ignore",
    timeout: 8_000
  });
  return result.status;
}

function currentTmuxSessionName(runtime: TerminalRuntime): string | undefined {
  const result = runtimeSpawn(runtime)("tmux", ["display-message", "-p", "#S"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000
  });
  return result.status === 0 ? String(result.stdout).trim() : undefined;
}

// When the caller is already inside tmux, attach the target session as a split
// (fallback: new window) of the surrounding session. This is instant and needs
// no external terminal app or macOS automation permission.
function openInSurroundingTmux(sessionName: string, runtime: TerminalRuntime): boolean {
  const env = runtimeEnv(runtime);
  if (!env.TMUX) {
    return false;
  }
  if (currentTmuxSessionName(runtime) === sessionName) {
    // Attaching a session inside itself would recurse endlessly.
    return false;
  }
  const inner = `TMUX= exec tmux attach-session -t ${shellQuote(sessionName)}`;
  const split = runtimeSpawn(runtime)("tmux", ["split-window", "-h", inner], {
    stdio: "ignore",
    timeout: 5_000
  });
  if (split.status === 0) {
    return true;
  }
  const window = runtimeSpawn(runtime)("tmux", ["new-window", inner], {
    stdio: "ignore",
    timeout: 5_000
  });
  return window.status === 0;
}

export function attachTmuxSession(
  sessionName: string,
  mode: TerminalAttachMode = "auto",
  runtime: TerminalRuntime = {}
): AttachResult {
  const command = tmuxAttachCommand(sessionName);
  const warnings: string[] = [];

  if (mode !== "external" && mode !== "print") {
    const terminal = checkCurrentTerminal(runtime);
    if (terminal.ok) {
      const result = runtimeSpawn(runtime)("tmux", ["attach-session", "-t", sessionName], {
        stdio: "inherit"
      });
      if (result.status === 0 || result.status === null) {
        return { attached: true, launchedExternal: false, command, warnings };
      }
      warnings.push(`tmux attach failed with exit ${result.status ?? "unknown"}.`);
    } else {
      warnings.push(`Cannot attach in current terminal: ${terminal.reasons.join("; ")}.`);
      if (mode === "current") {
        return { attached: false, launchedExternal: false, command, warnings };
      }
    }
  }

  if (mode !== "current" && mode !== "print") {
    // Already inside tmux (very common: the overseer runs in the user's
    // terminal): a nested split attach is instant and always works, while
    // external terminal apps need macOS automation permission.
    if (openInSurroundingTmux(sessionName, runtime)) {
      return { attached: false, launchedExternal: false, openedInTmux: true, command, warnings };
    }
    for (const externalCommand of externalAttachCommands(sessionName, runtime)) {
      const status = runShell(externalCommand, runtime);
      // status null means the launcher timed out (e.g. osascript stuck on a
      // permission prompt) — that is a failure, not a success.
      if (status === 0) {
        return {
          attached: false,
          launchedExternal: true,
          command,
          warnings
        };
      }
      warnings.push(
        status === null
          ? `External terminal launch timed out (likely waiting for macOS automation permission): ${externalCommand}`
          : `External terminal launch failed: ${externalCommand}`
      );
    }
  }

  warnings.push(`Attach manually with: ${command}`);
  return {
    attached: false,
    launchedExternal: false,
    command,
    warnings
  };
}
