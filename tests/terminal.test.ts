import { describe, expect, it } from "vitest";
import {
  attachTmuxSession,
  checkCurrentTerminal,
  externalAttachCommands,
  tmuxAttachCommand
} from "../src/terminal.js";

describe("terminal attach adapter", () => {
  it("rejects non-interactive or dumb terminals with clear reasons", () => {
    const check = checkCurrentTerminal({
      env: {
        TERM: "dumb"
      },
      stdoutIsTTY: false,
      stdinIsTTY: false
    });

    expect(check.ok).toBe(false);
    expect(check.reasons).toContain("current process is not attached to an interactive TTY");
    expect(check.reasons).toContain("TERM is dumb");
  });

  it("accepts a tty with usable terminfo and no nested tmux", () => {
    const check = checkCurrentTerminal({
      env: {
        TERM: "xterm-256color"
      },
      stdoutIsTTY: true,
      stdinIsTTY: true,
      spawn: (() => ({ status: 0, stdout: "", stderr: "" })) as never
    });

    expect(check).toEqual({
      ok: true,
      reasons: []
    });
  });

  it("builds deterministic external attach commands for macOS and Linux", () => {
    const mac = externalAttachCommands("arena run", {
      platform: "darwin",
      env: {},
      commandExists: (binary) => binary === "osascript"
    });
    expect(mac).toHaveLength(2);
    expect(mac[0]).toContain("Terminal");
    expect(mac[0]).toContain("tmux attach-session");

    const linux = externalAttachCommands("arena", {
      platform: "linux",
      env: {},
      commandExists: (binary) => binary === "kitty" || binary === "wezterm"
    });
    expect(linux).toEqual([
      "kitty sh -lc 'tmux attach-session -t arena'",
      "wezterm start -- sh -lc 'tmux attach-session -t arena'"
    ]);
  });

  it("suppresses external terminals over SSH (they would open on the remote display)", () => {
    const commands = externalAttachCommands("arena", {
      platform: "darwin",
      env: { SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" },
      commandExists: () => true
    });
    expect(commands).toEqual([]);
  });

  it("attaches directly when the current terminal is compatible", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = attachTmuxSession("arena", "auto", {
      env: {
        TERM: "xterm-256color"
      },
      stdoutIsTTY: true,
      stdinIsTTY: true,
      spawn: ((command: string, args: string[]) => {
        calls.push({ command, args });
        return { status: 0, stdout: "", stderr: "" };
      }) as never
    });

    expect(result.attached).toBe(true);
    expect(result.launchedExternal).toBe(false);
    expect(calls.at(-1)).toEqual({
      command: "tmux",
      args: ["attach-session", "-t", "arena"]
    });
  });

  it("opens a nested split attach when already inside tmux", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = attachTmuxSession("arena-run", "external", {
      platform: "darwin",
      env: {
        TERM: "xterm-256color",
        TMUX: "/tmp/tmux-1000/default,123,0"
      },
      spawn: ((command: string, args: string[]) => {
        calls.push({ command, args });
        if (command === "tmux" && args[0] === "display-message") {
          return { status: 0, stdout: "some-other-session\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      }) as never,
      commandExists: () => true
    });

    expect(result.openedInTmux).toBe(true);
    expect(result.attached).toBe(false);
    expect(result.launchedExternal).toBe(false);
    const split = calls.find((call) => call.command === "tmux" && call.args[0] === "split-window");
    expect(split?.args.join(" ")).toContain("attach-session -t arena-run");
  });

  it("does not nest-attach a session inside itself", () => {
    const result = attachTmuxSession("arena-run", "external", {
      platform: "linux",
      env: {
        TMUX: "/tmp/tmux-1000/default,123,0"
      },
      spawn: ((command: string, args: string[]) => {
        if (command === "tmux" && args[0] === "display-message") {
          return { status: 0, stdout: "arena-run\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "" };
      }) as never,
      commandExists: () => false
    });

    expect(result.openedInTmux).toBeUndefined();
    expect(result.launchedExternal).toBe(false);
  });

  it("treats a timed-out external launcher as failure, not success", () => {
    const result = attachTmuxSession("arena-run", "external", {
      platform: "darwin",
      env: {},
      // status null simulates spawnSync timeout (osascript stuck on the macOS
      // automation permission prompt).
      spawn: (() => ({ status: null, stdout: "", stderr: "" })) as never,
      commandExists: (binary: string) => binary === "osascript"
    });

    expect(result.launchedExternal).toBe(false);
    expect(result.attached).toBe(false);
    expect(result.warnings.join("\n")).toContain("timed out");
    expect(result.warnings.join("\n")).toContain("Attach manually with:");
  });

  it("prints a clean manual command when no terminal path is usable", () => {
    const result = attachTmuxSession("arena", "auto", {
      platform: "linux",
      env: {
        TERM: "dumb"
      },
      stdoutIsTTY: false,
      stdinIsTTY: false,
      commandExists: () => false
    });

    expect(result.attached).toBe(false);
    expect(result.launchedExternal).toBe(false);
    expect(result.command).toBe(tmuxAttachCommand("arena"));
    expect(result.warnings.join("\n")).toContain("Attach manually with: tmux attach-session -t arena");
  });
});
