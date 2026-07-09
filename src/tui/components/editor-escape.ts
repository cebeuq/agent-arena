import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { useCallback } from "react";
import { useStdin } from "ink";
import { shellQuote } from "../../shell.js";
import { enterTuiScreen, leaveTuiScreen } from "../screen-control.js";

let inkClear: (() => void) | undefined;

// The Ink instance owner (runArenaTui) registers its clear() so the editor can
// reset Ink's previous-frame cache after the alt screen is wiped and restored.
export function registerInkClear(clear: (() => void) | undefined): void {
  inkClear = clear;
}

export type OpenInEditor = (initial: string) => string | undefined;

function editorCommand(): string | undefined {
  const editor = process.env.VISUAL || process.env.EDITOR;
  return editor?.trim() || undefined;
}

// Returns a function that suspends the TUI, opens $VISUAL/$EDITOR on a temp file,
// and resumes. Returns undefined when no editor can run (non-TTY, no editor, or
// the editor exited non-zero) so callers can fall back to an inline prompt.
export function useEditorEscape(): OpenInEditor {
  const { setRawMode } = useStdin();

  return useCallback(
    (initial: string) => {
      const editor = editorCommand() ?? "vi";
      if (!process.stdout.isTTY || !process.stdin.isTTY) {
        return undefined;
      }

      const tmpFile = path.join(os.tmpdir(), `agent-arena-edit-${process.pid}-${Date.now()}.md`);
      try {
        fs.writeFileSync(tmpFile, initial, "utf8");
        setRawMode(false);
        leaveTuiScreen();
        // Synchronous spawn blocks the event loop, so Ink cannot paint mid-edit.
        const result = spawnSync("sh", ["-c", `${editor} ${shellQuote(tmpFile)}`], {
          stdio: "inherit"
        });
        enterTuiScreen();
        setRawMode(true);
        inkClear?.();
        if (result.status !== 0) {
          return undefined;
        }
        return fs.readFileSync(tmpFile, "utf8").replace(/\n$/, "");
      } catch {
        enterTuiScreen();
        setRawMode(true);
        inkClear?.();
        return undefined;
      } finally {
        fs.rmSync(tmpFile, { force: true });
      }
    },
    [setRawMode]
  );
}
