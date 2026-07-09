import { useCallback, useEffect, useRef, useState } from "react";
import type { AppShellStatus } from "./AppShell.js";

const TOAST_DURATION_MS = 2500;

export function useToast(): {
  toast: AppShellStatus | undefined;
  showToast: (text: string, tone?: AppShellStatus["tone"]) => void;
} {
  const [toast, setToast] = useState<AppShellStatus | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    []
  );

  const showToast = useCallback((text: string, tone: AppShellStatus["tone"] = "info") => {
    setToast({ text, tone });
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => {
      setToast(undefined);
    }, TOAST_DURATION_MS);
  }, []);

  return { toast, showToast };
}
