import { useContext, useLayoutEffect, useRef } from "react";
import { LayerContext } from "../layers.js";
import { KeyRegistryContext, type KeyHandler } from "./KeyProvider.js";

export const KEY_PRIORITY = {
  global: 10,
  screen: 20,
  list: 25,
  field: 30
} as const;

export type KeyPriority = (typeof KEY_PRIORITY)[keyof typeof KEY_PRIORITY];

export type UseKeysOptions = {
  priority?: number;
  enabled?: boolean;
};

// Register a keyboard handler in the layered dispatcher. Handlers on the topmost
// layer run highest-priority first; returning true consumes the event.
export function useKeys(handler: KeyHandler, options: UseKeysOptions = {}): void {
  const registry = useContext(KeyRegistryContext);
  const layer = useContext(LayerContext);
  const priority = options.priority ?? KEY_PRIORITY.screen;
  const enabled = options.enabled ?? true;
  const handlerRef = useRef<KeyHandler>(handler);
  handlerRef.current = handler;

  // useLayoutEffect, not useEffect: registration must be synchronous with the
  // commit that makes a screen visible. With a passive effect there is a window
  // where the new screen has rendered but its handlers are not registered yet,
  // so a fast keypress after a screen transition is routed to the old screen.
  useLayoutEffect(() => {
    if (!registry || !enabled) {
      return;
    }
    return registry.register({ layer, priority, handler: handlerRef });
  }, [registry, layer, priority, enabled]);
}
