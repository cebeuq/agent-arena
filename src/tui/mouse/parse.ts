export type TerminalMouseEvent = {
  x: number;
  y: number;
  buttonCode: number;
  kind: "press" | "release" | "scrollUp" | "scrollDown";
};

const SGR_SEQUENCE = /(?:\x1b)?\[<(\d+);(\d+);(\d+)([mM])/g;

function eventFromMatch(match: RegExpMatchArray): TerminalMouseEvent | undefined {
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

// Scans a whole stdin chunk for SGR mouse sequences. Fast clicks (or wheel
// bursts) batch press+release into a single read; parsing only one anchored
// sequence per chunk used to drop those events entirely. Sequences split
// across two stdin reads are still missed — there is deliberately no
// cross-chunk buffer (rare in practice, and buffering risks holding real
// keystrokes hostage).
export function parseMouseInputs(input: string): TerminalMouseEvent[] {
  const events: TerminalMouseEvent[] = [];
  for (const match of input.matchAll(SGR_SEQUENCE)) {
    const event = eventFromMatch(match);
    if (event) {
      events.push(event);
    }
  }
  return events;
}

// True when the chunk consists solely of one or more SGR mouse sequences.
// KeyProvider uses this to ignore mouse chunks without ever swallowing chunks
// that mix mouse bytes with real keystrokes.
export function isMouseOnlyInput(input: string): boolean {
  if (!input) {
    return false;
  }
  return input.replace(SGR_SEQUENCE, "") === "";
}

// Single-sequence variant: matches only when the chunk is exactly one mouse
// sequence.
export function parseMouseInput(input: string): TerminalMouseEvent | undefined {
  const normalized = input.startsWith("\x1b") ? input.slice(1) : input;
  const match = normalized.match(/^\[<(\d+);(\d+);(\d+)([mM])$/);
  if (!match) {
    return undefined;
  }
  return eventFromMatch(match);
}

export function isPrimaryClick(mouse: TerminalMouseEvent): boolean {
  return mouse.kind === "press" && mouse.buttonCode < 64 && (mouse.buttonCode & 3) === 0;
}
