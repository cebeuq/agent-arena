import { describe, expect, it } from "vitest";
import { enterTuiScreen, leaveTuiScreen } from "../src/tui/screen-control.js";
import { parseMouseInput } from "../src/tui/mouse/parse.js";

function stream(isTTY = true): { writes: string[]; stream: { isTTY: boolean; write: (chunk: string) => void } } {
  const writes: string[] = [];
  return {
    writes,
    stream: {
      isTTY,
      write: (chunk: string) => {
        writes.push(chunk);
      }
    }
  };
}

describe("TUI terminal screen control", () => {
  it("enters alternate screen before Ink renders", () => {
    const target = stream();

    enterTuiScreen(target.stream);

    expect(target.writes).toEqual(["\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?25l\x1b[40m\x1b[2J\x1b[H"]);
  });

  it("restores cursor, colors, and main screen on exit", () => {
    const target = stream();

    leaveTuiScreen(target.stream);

    expect(target.writes).toEqual(["\x1b[?2004l\x1b[?1006l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?1049l"]);
  });

  it("does not emit alternate-screen control for explicitly non-tty streams", () => {
    const target = stream(false);

    enterTuiScreen(target.stream);
    leaveTuiScreen(target.stream);

    expect(target.writes).toEqual([]);
  });

  it("parses SGR mouse press, release, and wheel events", () => {
    expect(parseMouseInput("[<0;12;7M")).toEqual({
      x: 12,
      y: 7,
      buttonCode: 0,
      kind: "press"
    });
    expect(parseMouseInput("\x1b[<0;12;7m")).toEqual({
      x: 12,
      y: 7,
      buttonCode: 0,
      kind: "release"
    });
    expect(parseMouseInput("[<64;5;4M")).toEqual({
      x: 5,
      y: 4,
      buttonCode: 64,
      kind: "scrollUp"
    });
    expect(parseMouseInput("[<65;5;4M")).toEqual({
      x: 5,
      y: 4,
      buttonCode: 65,
      kind: "scrollDown"
    });
    expect(parseMouseInput("x")).toBeUndefined();
  });
});
