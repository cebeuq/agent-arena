import React, { useEffect, useRef, useState } from "react";
import { Box, Text, type DOMElement } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { KeyProvider } from "../src/tui/keys/KeyProvider.js";
import { useKeys, KEY_PRIORITY } from "../src/tui/keys/useKeys.js";
import { MouseProvider } from "../src/tui/mouse/MouseProvider.js";
import { absoluteRect } from "../src/tui/mouse/geometry.js";
import { ModalProvider, useModal } from "../src/tui/components/ModalProvider.js";
import { SelectList, computeWindow, type SelectListItem } from "../src/tui/components/SelectList.js";
import { TextField } from "../src/tui/components/TextField.js";

function Providers({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <KeyProvider>
      <MouseProvider>
        <ModalProvider>{children}</ModalProvider>
      </MouseProvider>
    </KeyProvider>
  );
}

async function waitFor(assertion: () => void, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}

function click(stdin: { write: (data: string) => void }, x1Based: number, y1Based: number): void {
  stdin.write(`\x1b[<0;${x1Based};${y1Based}M`);
}

// Writes one keystroke and yields so React renders between events, like a real
// terminal where keystrokes arrive as separate stdin events.
async function press(stdin: { write: (data: string) => void }, data: string): Promise<void> {
  stdin.write(data);
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("computeWindow", () => {
  it("shows everything when it fits", () => {
    expect(computeWindow(3, 10, 0)).toEqual({ start: 0, capacity: 3, showAbove: false, showBelow: false });
  });

  it("reserves an indicator row below when clipped", () => {
    const window = computeWindow(10, 4, 0);
    expect(window.showAbove).toBe(false);
    expect(window.showBelow).toBe(true);
    expect(window.capacity).toBe(3);
  });

  it("reserves indicator rows above and below mid-scroll", () => {
    const window = computeWindow(10, 4, 3);
    expect(window.showAbove).toBe(true);
    expect(window.showBelow).toBe(true);
    expect(window.capacity).toBe(2);
  });
});

describe("KeyProvider layered dispatch", () => {
  it("dispatches by priority and stops at the first consumer", async () => {
    const seen: string[] = [];

    function Harness(): React.ReactElement {
      useKeys(
        (input) => {
          if (input === "z") {
            seen.push(`field:${input}`);
            return true;
          }
          return false;
        },
        { priority: KEY_PRIORITY.field }
      );
      useKeys((input) => {
        seen.push(`screen:${input}`);
        return true;
      });
      return <Text>keys</Text>;
    }

    const { stdin } = render(
      <Providers>
        <Harness />
      </Providers>
    );
    await waitFor(() => expect(seen).toEqual([]));

    stdin.write("z");
    await waitFor(() => expect(seen).toEqual(["field:z"]));

    stdin.write("q");
    await waitFor(() => expect(seen).toEqual(["field:z", "screen:q"]));
  });

  it("drops SGR mouse sequences before key handlers see them", async () => {
    const seen: string[] = [];

    function Harness(): React.ReactElement {
      useKeys((input) => {
        seen.push(input);
        return true;
      });
      return <Text>keys</Text>;
    }

    const { stdin } = render(
      <Providers>
        <Harness />
      </Providers>
    );
    stdin.write("\x1b[<0;3;3M");
    stdin.write("k");
    await waitFor(() => expect(seen).toEqual(["k"]));
  });
});

describe("SelectList", () => {
  const items: Array<SelectListItem<string>> = [
    { value: "alpha", label: "Alpha row" },
    { value: "beta", label: "Beta row" },
    { value: "gamma", label: "Gamma row" },
    { value: "delta", label: "Delta row" },
    { value: "epsilon", label: "Epsilon row" }
  ];

  function ListHarness({
    onActivate,
    height = 10,
    listItems = items
  }: {
    onActivate: (value: string) => void;
    height?: number;
    listItems?: Array<SelectListItem<string>>;
  }): React.ReactElement {
    const [selected, setSelected] = useState<string | undefined>(listItems.find((item) => !item.header)?.value);
    return (
      <Providers>
        <SelectList
          items={listItems}
          selected={selected}
          onSelect={setSelected}
          onActivate={onActivate}
          height={height}
        />
      </Providers>
    );
  }

  it("navigates with arrows and activates with Enter", async () => {
    const activated: string[] = [];
    const { stdin, lastFrame } = render(<ListHarness onActivate={(value) => activated.push(value)} />);

    await waitFor(() => expect(lastFrame()).toContain("Alpha row"));
    await press(stdin, "\x1b[B"); // down
    await press(stdin, "\x1b[B"); // down
    await press(stdin, "\r");
    await waitFor(() => expect(activated).toEqual(["gamma"]));
  });

  it("activates the clicked row through layout-derived hit testing", async () => {
    const activated: string[] = [];
    const { stdin, lastFrame } = render(<ListHarness onActivate={(value) => activated.push(value)} />);
    await waitFor(() => expect(lastFrame()).toContain("Delta row"));

    const lines = lastFrame()!.split("\n");
    const rowIndex = lines.findIndex((line) => line.includes("Delta row"));
    expect(rowIndex).toBeGreaterThanOrEqual(0);
    click(stdin, 3, rowIndex + 1);
    await waitFor(() => expect(activated).toEqual(["delta"]));
  });

  it("windows long lists with scroll indicators and wheel scrolling", async () => {
    const many: Array<SelectListItem<string>> = Array.from({ length: 10 }, (_item, index) => ({
      value: `item-${index}`,
      label: `Item number ${index}`
    }));
    const { stdin, lastFrame } = render(<ListHarness onActivate={() => {}} listItems={many} height={4} />);

    await waitFor(() => {
      expect(lastFrame()).toContain("Item number 0");
      expect(lastFrame()).toContain("more");
      expect(lastFrame()).not.toContain("Item number 9");
    });

    stdin.write("\x1b[<65;2;2M"); // wheel down
    await waitFor(() => {
      expect(lastFrame()).toContain("▲ 1 more");
    });
  });

  it("does not activate header rows on click", async () => {
    const activated: string[] = [];
    const withHeader: Array<SelectListItem<string>> = [
      { value: "h", label: "Team Red", header: true },
      { value: "one", label: "First member" }
    ];
    const { stdin, lastFrame } = render(
      <ListHarness onActivate={(value) => activated.push(value)} listItems={withHeader} />
    );
    await waitFor(() => expect(lastFrame()).toContain("Team Red"));
    const lines = lastFrame()!.split("\n");
    const headerIndex = lines.findIndex((line) => line.includes("Team Red"));
    click(stdin, 3, headerIndex + 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(activated).toEqual([]);
  });
});

describe("TextField", () => {
  function FieldHarness({ onSubmit }: { onSubmit: (value: string) => void }): React.ReactElement {
    const [value, setValue] = useState("");
    return (
      <Providers>
        <TextField value={value} onChange={setValue} onSubmit={onSubmit} width={30} placeholder="type here" />
      </Providers>
    );
  }

  it("shows a placeholder when empty", async () => {
    const { lastFrame } = render(<FieldHarness onSubmit={() => {}} />);
    await waitFor(() => expect(lastFrame()).toContain("type here"));
  });

  it("supports cursor movement and mid-string editing", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame } = render(<FieldHarness onSubmit={(value) => submitted.push(value)} />);

    stdin.write("hello");
    await waitFor(() => expect(lastFrame()).toContain("hello"));

    await press(stdin, "\x1b[D"); // left
    await press(stdin, "\x1b[D"); // left
    await press(stdin, "X");
    await waitFor(() => expect(lastFrame()).toContain("helXlo"));

    await press(stdin, "\x01"); // ctrl+a -> home
    await press(stdin, "Y");
    await waitFor(() => expect(lastFrame()).toContain("YhelXlo"));

    await press(stdin, "\r");
    await waitFor(() => expect(submitted).toEqual(["YhelXlo"]));
  });

  it("clears to start with ctrl+u and deletes with backspace", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame } = render(<FieldHarness onSubmit={(value) => submitted.push(value)} />);

    stdin.write("abcdef");
    await waitFor(() => expect(lastFrame()).toContain("abcdef"));
    await press(stdin, "\x7f"); // backspace
    await waitFor(() => expect(lastFrame()).toContain("abcde"));
    await press(stdin, "\x15"); // ctrl+u
    await press(stdin, "\r");
    await waitFor(() => expect(submitted).toEqual([""]));
  });

  it("inserts a pasted block with newlines as spaces instead of submitting early", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame } = render(<FieldHarness onSubmit={(value) => submitted.push(value)} />);

    // Terminal-wrapped copy: hard newlines mid-text. Must not truncate at the
    // first newline or fire submit. (The 30-col field scrolls, so only the
    // tail is visible; the submitted value proves nothing was lost.)
    stdin.write("make it fast\nwithout changing predictions");
    await waitFor(() => expect(lastFrame()).toContain("without changing predictions"));
    expect(submitted).toEqual([]);

    await press(stdin, "\r");
    await waitFor(() => expect(submitted).toEqual(["make it fast without changing predictions"]));
  });

  it("strips bracketed paste markers", async () => {
    const submitted: string[] = [];
    const { stdin, lastFrame } = render(<FieldHarness onSubmit={(value) => submitted.push(value)} />);

    stdin.write("\x1b[200~pasted text\x1b[201~");
    await waitFor(() => expect(lastFrame()).toContain("pasted text"));
    expect(lastFrame()).not.toContain("200~");
    expect(lastFrame()).not.toContain("201~");
    expect(submitted).toEqual([]);
  });
});

describe("ModalProvider + ConfirmDialog", () => {
  function ConfirmHarness({ onResult }: { onResult: (value: boolean) => void }): React.ReactElement {
    const modal = useModal();
    const behind: string[] = [];
    useKeys((input) => {
      behind.push(input);
      return true;
    });
    useEffect(() => {
      void modal.confirm({ title: "Remove agent", message: "Remove red-claude? This cannot be undone." }).then(onResult);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <Text>screen behind modal</Text>;
  }

  it("resolves true on y and renders the dialog", async () => {
    const results: boolean[] = [];
    const { stdin, lastFrame } = render(
      <Providers>
        <ConfirmHarness onResult={(value) => results.push(value)} />
      </Providers>
    );
    await waitFor(() => expect(lastFrame()).toContain("Remove red-claude?"));
    stdin.write("y");
    await waitFor(() => expect(results).toEqual([true]));
  });

  it("resolves false on Escape", async () => {
    const results: boolean[] = [];
    const { stdin, lastFrame } = render(
      <Providers>
        <ConfirmHarness onResult={(value) => results.push(value)} />
      </Providers>
    );
    await waitFor(() => expect(lastFrame()).toContain("Remove agent"));
    stdin.write("\x1b");
    await waitFor(() => expect(results).toEqual([false]));
  });

  it("blocks key handlers behind the modal while open", async () => {
    const seen: string[] = [];
    function Harness(): React.ReactElement {
      const modal = useModal();
      useKeys((input) => {
        seen.push(input);
        return true;
      });
      useEffect(() => {
        void modal.confirm({ title: "T", message: "M" });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <Text>behind</Text>;
    }
    const { stdin, lastFrame } = render(
      <Providers>
        <Harness />
      </Providers>
    );
    await waitFor(() => expect(lastFrame()).toContain("T"));
    await press(stdin, "x");
    expect(seen).toEqual([]);
    await press(stdin, "y"); // closes modal
    await press(stdin, "x");
    await waitFor(() => expect(seen).toEqual(["x"]));
  });
});

describe("absoluteRect", () => {
  it("computes nested box offsets from the live yoga layout", async () => {
    const captured: { ref?: React.RefObject<DOMElement | null> } = {};

    function RectProbe(): React.ReactElement {
      const ref = useRef<DOMElement | null>(null);
      captured.ref = ref;
      return (
        <Box paddingLeft={4} paddingTop={2}>
          <Box ref={ref}>
            <Text>hi</Text>
          </Box>
        </Box>
      );
    }

    render(
      <Providers>
        <RectProbe />
      </Providers>
    );

    await waitFor(() => {
      const rect = absoluteRect(captured.ref?.current);
      expect(rect).toBeDefined();
      expect(rect!.x).toBe(4);
      expect(rect!.y).toBe(2);
      expect(rect!.height).toBe(1);
    });
  });
});
