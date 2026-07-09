import { useEffect, useState } from "react";
import { useStdout } from "ink";

export type TerminalSize = {
  columns: number;
  rows: number;
};

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>({
    columns: stdout?.columns ?? 100,
    rows: stdout?.rows ?? 32
  });

  useEffect(() => {
    if (!stdout) {
      return;
    }
    const onResize = (): void => {
      setSize({
        columns: stdout.columns ?? 100,
        rows: stdout.rows ?? 32
      });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
