import { createContext } from "react";

// Input layering shared by keyboard and mouse dispatch. Handlers registered at a
// lower layer than the topmost registered layer receive no events, which is what
// makes modal overlays block the screens behind them without coordination.
export const LayerContext = createContext(0);

export const MODAL_LAYER_STEP = 100;
