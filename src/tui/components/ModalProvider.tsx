import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { Box } from "ink";
import { LayerContext, MODAL_LAYER_STEP } from "../layers.js";
import { theme } from "../theme.js";
import { useTerminalSize } from "./useTerminalSize.js";
import { ConfirmDialog, type ConfirmOptions } from "./ConfirmDialog.js";

type ModalEntry = {
  id: number;
  node: React.ReactNode;
  width?: number;
};

export type ModalHandle = {
  close: () => void;
};

export type ModalApi = {
  openModal: (render: (close: () => void) => React.ReactNode, options?: { width?: number }) => ModalHandle;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
};

const ModalContext = createContext<ModalApi | undefined>(undefined);

export function useModal(): ModalApi {
  const api = useContext(ModalContext);
  if (!api) {
    throw new Error("useModal must be used inside ModalProvider.");
  }
  return api;
}

export function ModalProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [modals, setModals] = useState<ModalEntry[]>([]);
  const nextId = useRef(1);
  const baseLayer = useContext(LayerContext);
  const { columns, rows } = useTerminalSize();

  const openModal = useCallback<ModalApi["openModal"]>((render, options) => {
    const id = nextId.current;
    nextId.current += 1;
    const close = (): void => {
      setModals((current) => current.filter((entry) => entry.id !== id));
    };
    setModals((current) => [...current, { id, node: render(close), width: options?.width }]);
    return { close };
  }, []);

  const confirm = useCallback<ModalApi["confirm"]>(
    (options) =>
      new Promise<boolean>((resolve) => {
        openModal((close) => (
          <ConfirmDialog
            {...options}
            onResult={(result) => {
              close();
              resolve(result);
            }}
          />
        ));
      }),
    [openModal]
  );

  const api = useMemo<ModalApi>(() => ({ openModal, confirm }), [openModal, confirm]);

  return (
    <ModalContext.Provider value={api}>
      <Box flexDirection="column" minHeight={modals.length > 0 ? rows : undefined}>
        {children}
        {modals.map((modal, index) => {
          const width = Math.min(modal.width ?? 60, Math.max(20, columns - 4));
          const marginLeft = Math.max(0, Math.floor((columns - width) / 2));
          const marginTop = Math.max(0, Math.floor(rows / 2) - 5);
          return (
            <LayerContext.Provider key={modal.id} value={baseLayer + MODAL_LAYER_STEP * (index + 1)}>
              <Box
                position="absolute"
                marginLeft={marginLeft}
                marginTop={marginTop}
                width={width}
                flexDirection="column"
                borderStyle="round"
                borderColor={theme.active}
                backgroundColor={theme.modalBg}
                paddingX={1}
              >
                {modal.node}
              </Box>
            </LayerContext.Provider>
          );
        })}
      </Box>
    </ModalContext.Provider>
  );
}
