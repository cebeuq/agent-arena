import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, type DOMElement } from "ink";
import { USER_SENDER_ID } from "../../chat.js";
import { theme } from "../theme.js";
import { useKeys } from "../keys/useKeys.js";
import { useMouseRegion } from "../mouse/useMouseRegion.js";
import { Panel } from "../components/Panel.js";
import { SelectList, type SelectListItem } from "../components/SelectList.js";
import { TextField } from "../components/TextField.js";
import { useTerminalSize } from "../components/useTerminalSize.js";
import { buildThreads, threadMessages, unreadMessageIdsForUser, type ChatThread } from "./model.js";
import { useOverseer } from "./overseer-app.js";

export function ChatView(): React.ReactElement {
  const { snapshot, actions, readOnly, chatThreadId, showToast } = useOverseer();
  const { rows, columns } = useTerminalSize();
  const threads = useMemo(() => buildThreads(snapshot), [snapshot]);
  const [threadId, setThreadId] = useState<string>(chatThreadId ?? "public");
  const [focus, setFocus] = useState<"threads" | "input">("threads");
  const [draft, setDraft] = useState("");
  const [scrollback, setScrollback] = useState(0);
  const logRef = useRef<DOMElement | null>(null);
  const markedRef = useRef<string>("");

  useEffect(() => {
    if (chatThreadId) {
      setThreadId(chatThreadId);
    }
  }, [chatThreadId]);

  const thread = threads.find((candidate) => candidate.id === threadId) ?? threads[0];
  const messages = useMemo(() => (thread ? threadMessages(snapshot, thread) : []), [snapshot, thread]);

  // Mark the open thread read (debounced by thread identity + message count).
  useEffect(() => {
    if (!thread) {
      return;
    }
    const unreadIds = unreadMessageIdsForUser(snapshot, thread);
    const marker = `${thread.id}:${unreadIds.join(",")}`;
    if (unreadIds.length === 0 || markedRef.current === marker) {
      return;
    }
    markedRef.current = marker;
    const timer = setTimeout(() => {
      void actions.markThreadRead(unreadIds);
    }, 400);
    return () => clearTimeout(timer);
  }, [snapshot, thread, actions]);

  const threadItems: Array<SelectListItem<string>> = threads.map((candidate) => ({
    value: candidate.id,
    label: candidate.label,
    detail: candidate.unread > 0 ? `(${candidate.unread})` : ""
  }));

  const logHeight = Math.max(4, rows - 15);
  const maxScrollback = Math.max(0, messages.length - 1);
  const clampedScrollback = Math.min(scrollback, maxScrollback);
  // Messages wrap (long agent messages used to be unreadable one-line
  // truncations), so budget the log by estimated wrapped lines: walk backwards
  // from the scroll position and take as many newest messages as fit.
  const logWidth = Math.max(20, Math.floor(columns * 0.7) - 6);
  const end = messages.length - clampedScrollback;
  let lineBudget = logHeight;
  let start = end;
  while (start > 0) {
    const candidate = messages[start - 1];
    const estimated = Math.max(
      1,
      Math.ceil((`00:00 ${candidate.fromCodename}: ${candidate.message}`).length / logWidth)
    );
    if (estimated > lineBudget && start !== end) {
      break;
    }
    lineBudget -= estimated;
    start -= 1;
    if (lineBudget <= 0) {
      break;
    }
  }
  const visible = messages.slice(start, end);

  function sendDraft(text: string): void {
    const body = text.trim();
    if (!body || !thread) {
      return;
    }
    void (async () => {
      try {
        await actions.sendUserChat({
          scope: thread.kind === "public" ? "public" : thread.kind === "team" ? "team" : "dm",
          teamId: thread.kind === "team" ? thread.teamId : undefined,
          toAgentId: thread.kind === "dm" ? thread.agentId : undefined,
          message: body
        });
        setDraft("");
        setScrollback(0);
        // Return focus to the thread list so global shortcuts (1-4, q, o…)
        // work again; a focused TextField would swallow them as text.
        setFocus("threads");
      } catch (error) {
        showToast((error as Error).message, "error");
      }
    })();
  }

  useKeys((_input, key) => {
    if (key.pageUp) {
      setScrollback((current) => Math.min(maxScrollback, current + 5));
      return true;
    }
    if (key.pageDown) {
      setScrollback((current) => Math.max(0, current - 5));
      return true;
    }
    return false;
  });

  useMouseRegion(logRef, {
    onWheel: ({ direction }) => {
      setScrollback((current) =>
        direction === "up" ? Math.min(maxScrollback, current + 3) : Math.max(0, current - 3)
      );
    }
  });

  function renderMessage(messageId: string, from: string, body: string, mine: boolean): React.ReactElement {
    return (
      <Text key={messageId} wrap="wrap">
        <Text color={mine ? theme.active : theme.warning}>{from}</Text>
        <Text>: {body}</Text>
      </Text>
    );
  }

  return (
    <Box flexGrow={1}>
      <Box width="30%" flexDirection="column">
        <Panel title="Threads" flexGrow={1}>
          <SelectList
            items={threadItems}
            selected={thread?.id}
            onSelect={(value) => {
              setThreadId(value);
              setScrollback(0);
            }}
            onActivate={() => {
              if (!readOnly) {
                setFocus("input");
              }
            }}
            height={Math.max(4, rows - 14)}
            focused={focus === "threads"}
          />
        </Panel>
      </Box>
      <Box width="70%" flexDirection="column">
        <Panel title={`${thread?.label ?? "Chat"}${clampedScrollback > 0 ? ` (scrolled ${clampedScrollback})` : ""}`} flexGrow={1}>
          <Box ref={logRef} flexDirection="column" flexGrow={1}>
            {visible.length > 0 ? (
              visible.map((message) =>
                renderMessage(
                  message.id,
                  `${message.createdAt.slice(11, 16)} ${message.fromCodename}`,
                  message.message,
                  message.fromAgentId === USER_SENDER_ID
                )
              )
            ) : (
              <Text color={theme.dim}>No messages in this thread yet.</Text>
            )}
          </Box>
        </Panel>
        {readOnly ? (
          <Panel>
            <Text color={theme.dim}>Run finished — chat is read-only history.</Text>
          </Panel>
        ) : (
          <Panel
            title={
              focus === "input"
                ? "Message as Director (Enter sends · Esc back to threads)"
                : "Message (Enter on a thread to write)"
            }
          >
            <TextField
              value={draft}
              onChange={setDraft}
              onSubmit={sendDraft}
              onCancel={() => setFocus("threads")}
              focused={focus === "input"}
              width={70}
              placeholder={thread ? `Send to ${thread.label}…` : "Pick a thread"}
            />
          </Panel>
        )}
      </Box>
    </Box>
  );
}
