export type TuiScreenStream = {
  isTTY?: boolean;
  write: (chunk: string) => unknown;
};

export function enterTuiScreen(stdout: TuiScreenStream = process.stdout): void {
  if (stdout.isTTY === false) {
    return;
  }
  // 1049: alternate screen · 1000/1006: mouse tracking · 2004: bracketed paste
  // (pastes arrive marked, so a newline inside a paste is never a submit).
  stdout.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?25l\x1b[40m\x1b[2J\x1b[H");
}

export function leaveTuiScreen(stdout: TuiScreenStream = process.stdout): void {
  if (stdout.isTTY === false) {
    return;
  }
  stdout.write("\x1b[?2004l\x1b[?1006l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?1049l");
}
