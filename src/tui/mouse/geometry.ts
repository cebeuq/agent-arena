import type { DOMElement } from "ink";

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// Absolute 0-based rect of an Ink Box, computed from the live yoga layout at the
// moment of the call. There are deliberately no stored coordinates anywhere in
// the mouse system: hit targets can never drift from what is rendered.
export function absoluteRect(node: DOMElement | null | undefined): Rect | undefined {
  if (!node?.yogaNode) {
    return undefined;
  }

  const width = node.yogaNode.getComputedWidth();
  const height = node.yogaNode.getComputedHeight();
  let x = node.yogaNode.getComputedLeft();
  let y = node.yogaNode.getComputedTop();

  let current = node.parentNode;
  while (current) {
    if (current.yogaNode) {
      x += current.yogaNode.getComputedLeft();
      y += current.yogaNode.getComputedTop();
    }
    current = current.parentNode;
  }

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return undefined;
  }

  return { x, y, width, height };
}

export function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export function rectArea(rect: Rect): number {
  return rect.width * rect.height;
}
