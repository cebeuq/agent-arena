import React, { useContext, useLayoutEffect, useRef } from "react";
import type { DOMElement } from "ink";
import { LayerContext } from "../layers.js";
import { MouseRegistryContext, type MouseRegionOptions } from "./MouseProvider.js";

// Register a ref'd Box as a mouse target. The hit rectangle is computed from the
// live yoga layout when an event arrives, never stored.
export function useMouseRegion(ref: React.RefObject<DOMElement | null>, options: MouseRegionOptions): void {
  const registry = useContext(MouseRegistryContext);
  const layer = useContext(LayerContext);
  const optionsRef = useRef<MouseRegionOptions>(options);
  optionsRef.current = options;

  // useLayoutEffect for the same reason as useKeys: a click right after a
  // screen transition must hit the new screen's regions, not the old screen's.
  useLayoutEffect(() => {
    if (!registry) {
      return;
    }
    return registry.register({ layer, ref, options: optionsRef });
  }, [registry, layer, ref]);
}
