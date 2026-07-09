import React, { createContext, useEffect, useMemo, useRef } from "react";
import { useStdin, type DOMElement } from "ink";
import { absoluteRect, rectArea, rectContains, type Rect } from "./geometry.js";
import { isPrimaryClick, parseMouseInput } from "./parse.js";

export type MousePressEvent = {
  localX: number;
  localY: number;
};

export type MouseWheelEvent = {
  direction: "up" | "down";
};

export type MouseRegionOptions = {
  onPress?: (event: MousePressEvent) => void;
  onWheel?: (event: MouseWheelEvent) => void;
  disabled?: boolean;
};

export type MouseRegionRegistration = {
  layer: number;
  ref: React.RefObject<DOMElement | null>;
  options: React.RefObject<MouseRegionOptions>;
};

export type MouseRegistry = {
  register: (registration: MouseRegionRegistration) => () => void;
};

export const MouseRegistryContext = createContext<MouseRegistry | undefined>(undefined);

function mouseEnabled(): boolean {
  return process.env.AGENT_ARENA_NO_MOUSE !== "1";
}

type Candidate = {
  registration: MouseRegionRegistration;
  rect: Rect;
};

export function MouseProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { stdin } = useStdin();
  const registrations = useRef(new Set<MouseRegionRegistration>());

  const registry = useMemo<MouseRegistry>(
    () => ({
      register(registration) {
        registrations.current.add(registration);
        return () => {
          registrations.current.delete(registration);
        };
      }
    }),
    []
  );

  useEffect(() => {
    if (!stdin || !mouseEnabled()) {
      return;
    }

    const listener = (data: Buffer | string): void => {
      const event = parseMouseInput(String(data));
      if (!event) {
        return;
      }
      // SGR coordinates are 1-based; rects are 0-based.
      const pointX = event.x - 1;
      const pointY = event.y - 1;
      const wantWheel = event.kind === "scrollUp" || event.kind === "scrollDown";
      if (!wantWheel && !isPrimaryClick(event)) {
        return;
      }

      const all = [...registrations.current].filter((registration) => !registration.options.current?.disabled);
      if (all.length === 0) {
        return;
      }
      const topLayer = Math.max(...all.map((registration) => registration.layer));
      const candidates: Candidate[] = [];
      for (const registration of all) {
        if (registration.layer !== topLayer) {
          continue;
        }
        const handlerPresent = wantWheel ? registration.options.current?.onWheel : registration.options.current?.onPress;
        if (!handlerPresent) {
          continue;
        }
        const rect = absoluteRect(registration.ref.current);
        if (rect && rectContains(rect, pointX, pointY)) {
          candidates.push({ registration, rect });
        }
      }
      if (candidates.length === 0) {
        return;
      }

      const innermost = candidates.sort((left, right) => rectArea(left.rect) - rectArea(right.rect))[0];
      if (wantWheel) {
        innermost.registration.options.current?.onWheel?.({
          direction: event.kind === "scrollUp" ? "up" : "down"
        });
        return;
      }
      innermost.registration.options.current?.onPress?.({
        localX: pointX - innermost.rect.x,
        localY: pointY - innermost.rect.y
      });
    };

    stdin.on("data", listener);
    return () => {
      stdin.off("data", listener);
    };
  }, [stdin]);

  return <MouseRegistryContext.Provider value={registry}>{children}</MouseRegistryContext.Provider>;
}
