import React, { createContext, useMemo, useRef } from "react";
import { useInput, type Key } from "ink";
import { isMouseOnlyInput } from "../mouse/parse.js";

export type KeyHandler = (input: string, key: Key) => boolean | void;

export type KeyRegistration = {
  layer: number;
  priority: number;
  handler: React.RefObject<KeyHandler>;
};

export type KeyRegistry = {
  register: (registration: KeyRegistration) => () => void;
};

export const KeyRegistryContext = createContext<KeyRegistry | undefined>(undefined);

export function KeyProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const registrations = useRef(new Set<KeyRegistration>());

  const registry = useMemo<KeyRegistry>(
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

  useInput((input, key) => {
    // Chunks made up entirely of mouse sequences (one or more — fast clicks
    // batch press+release into a single read) belong to MouseProvider.
    if (isMouseOnlyInput(input)) {
      return;
    }

    const all = [...registrations.current];
    if (all.length === 0) {
      return;
    }
    const topLayer = Math.max(...all.map((registration) => registration.layer));
    const active = all
      .filter((registration) => registration.layer === topLayer)
      .sort((left, right) => right.priority - left.priority);
    for (const registration of active) {
      if (registration.handler.current?.(input, key) === true) {
        return;
      }
    }
  });

  return <KeyRegistryContext.Provider value={registry}>{children}</KeyRegistryContext.Provider>;
}
