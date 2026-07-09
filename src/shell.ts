import { exec, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import type { ShellResult } from "./types.js";

const execAsync = promisify(exec);

export function shellQuote(value: string): string {
  if (value.length === 0) {
    return "''";
  }

  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function extractCommandBinary(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("'") || trimmed.startsWith('"')) {
    const quote = trimmed[0];
    const end = trimmed.indexOf(quote, 1);
    return end > 1 ? trimmed.slice(1, end) : undefined;
  }

  return trimmed.split(/\s+/, 1)[0];
}

export function commandExists(binary: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(binary)}`], {
    encoding: "utf8"
  });
  return result.status === 0;
}

// Preserves leading whitespace: output like `git status --short` starts with a
// meaningful status column (" M path"), and trimming the blob would corrupt the
// first line. Callers strip trailing whitespace themselves when needed.
export function runCheckedRaw(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}\n${result.stderr}`
    );
  }

  return result.stdout;
}

export function runChecked(command: string, args: string[], cwd?: string): string {
  return runCheckedRaw(command, args, cwd).trim();
}

export async function runShell(command: string, cwd: string, env?: Record<string, string>): Promise<ShellResult> {
  try {
    const result = await execAsync(command, {
      cwd,
      env: {
        ...process.env,
        ...env
      },
      maxBuffer: 1024 * 1024 * 20
    });

    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };

    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message
    };
  }
}
