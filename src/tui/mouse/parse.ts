export type TerminalMouseEvent = {
  x: number;
  y: number;
  buttonCode: number;
  kind: "press" | "release" | "scrollUp" | "scrollDown";
};

export function parseMouseInput(input: string): TerminalMouseEvent | undefined {
  const normalized = input.startsWith("\x1b") ? input.slice(1) : input;
  const match = normalized.match(/^\[<(\d+);(\d+);(\d+)([mM])$/);
  if (!match) {
    return undefined;
  }

  const buttonCode = Number.parseInt(match[1], 10);
  const x = Number.parseInt(match[2], 10);
  const y = Number.parseInt(match[3], 10);
  if (!Number.isFinite(buttonCode) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return undefined;
  }

  if (buttonCode === 64) {
    return { x, y, buttonCode, kind: "scrollUp" };
  }
  if (buttonCode === 65) {
    return { x, y, buttonCode, kind: "scrollDown" };
  }

  return {
    x,
    y,
    buttonCode,
    kind: match[4] === "m" ? "release" : "press"
  };
}

export function isPrimaryClick(mouse: TerminalMouseEvent): boolean {
  return mouse.kind === "press" && mouse.buttonCode < 64 && (mouse.buttonCode & 3) === 0;
}
