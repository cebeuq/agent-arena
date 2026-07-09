import { describe, expect, it } from "vitest";
import { enterTuiScreen, leaveTuiScreen } from "../src/tui/screen-control.js";
import { isMouseOnlyInput, parseMouseInput, parseMouseInputs } from "../src/tui/mouse/parse.js";

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

  it("scans multiple SGR sequences batched into one stdin chunk", () => {
    // A fast click delivers press+release in a single read; both must survive.
    const events = parseMouseInputs("\x1b[<0;10;5M\x1b[<0;10;5m");
    expect(events.map((event) => event.kind)).toEqual(["press", "release"]);
    expect(events[0]).toMatchObject({ x: 10, y: 5, buttonCode: 0 });

    expect(parseMouseInputs("\x1b[<64;3;2M\x1b[<64;3;2M\x1b[<64;3;2M")).toHaveLength(3);
    expect(parseMouseInputs("plain keys")).toEqual([]);
  });

  it("identifies mouse-only chunks for the key path", () => {
    expect(isMouseOnlyInput("\x1b[<0;10;5M\x1b[<0;10;5m")).toBe(true);
    expect(isMouseOnlyInput("[<0;10;5M")).toBe(true);
    expect(isMouseOnlyInput("q")).toBe(false);
    expect(isMouseOnlyInput("\x1b[<0;10;5Mq")).toBe(false);
    expect(isMouseOnlyInput("")).toBe(false);
  });
});
