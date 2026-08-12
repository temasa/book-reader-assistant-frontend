"use client";

import { v4 as uuidv4 } from "uuid";
import { ReactNode, useEffect, useRef, useState, FormEvent } from "react";
import { cn } from "@/lib/utils";
import { useStreamContext } from "@/providers/Stream";
import { Button } from "../ui/button";
import { Checkpoint, Message } from "@langchain/langgraph-sdk";
import { AssistantMessage, AssistantMessageLoading } from "./messages/ai";
import { HumanMessage } from "./messages/human";
import { DO_NOT_RENDER_ID_PREFIX, ensureToolCallsHaveResponses } from "@/lib/ensure-tool-responses";
import { ArrowDown, LoaderCircle, SquarePen } from "lucide-react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { toast } from "sonner";
import { extractCitationLocations } from "@/lib/citations";
import { useRightPanel } from "../right-panel/RightPanelContext";
import type { Book } from "@/lib/books-api";
import { useQueryState, parseAsBoolean } from "nuqs";

function StickyToBottomContent(props: {
  content: ReactNode;
  footer?: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const context = useStickToBottomContext();
  return (
    <div
      ref={context.scrollRef}
      style={{ width: "100%", height: "100%" }}
      className={props.className}
    >
      <div ref={context.contentRef} className={props.contentClassName}>
        {props.content}
      </div>
      {props.footer}
    </div>
  );
}

function messageText(message: Message): string {
  return Array.isArray(message.content)
    ? message.content
        .map((c: any) => (typeof c === "string" ? c : (c.text ?? "")))
        .join("")
    : String(message.content ?? "");
}

function ScrollToBottom(props: { className?: string }) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <Button variant="outline" className={props.className} onClick={() => scrollToBottom()}>
      <ArrowDown className="h-4 w-4" />
      <span>Scroll to bottom</span>
    </Button>
  );
}

export function BookThread({
  book,
  onNewThread,
}: {
  book: Book;
  onNewThread: () => void;
}) {
  const { openLocation, showCollection } = useRightPanel();
  const [input, setInput] = useState("");
  const [hasAssistantText, setHasAssistantText] = useState(false);

  const stream = useStreamContext();
  const messages = stream.messages;
  const isLoading = stream.isLoading;
  const lastError = useRef<string | undefined>(undefined);
  const seenAssistantIds = useRef<Set<string>>(new Set());

  // Never show the generic tool-call/tool-result fallback UI in this app —
  // only registered generative-UI components (pushed via values.ui) should render.
  const [, setHideToolCalls] = useQueryState(
    "hideToolCalls",
    parseAsBoolean.withDefault(false),
  );
  useEffect(() => {
    setHideToolCalls(true, { history: "replace" });
  }, [setHideToolCalls]);

  useEffect(() => {
    if (!stream.error) {
      lastError.current = undefined;
      return;
    }
    try {
      const message = (stream.error as any).message;
      if (!message || lastError.current === message) return;
      lastError.current = message;
      toast.error("An error occurred. Please try again.", {
        description: <p><strong>Error:</strong> <code>{message}</code></p>,
        richColors: true,
        closeButton: true,
      });
    } catch {
      // no-op
    }
  }, [stream.error]);

  const prevMessageLength = useRef(0);
  useEffect(() => {
    // A new AI turn starts as an empty placeholder message (e.g. while the
    // agent is retrieving/tool-calling) before any answer text streams in.
    // Only clear the loading indicator once real text is actually present,
    // so retrieval time stays visibly "loading" instead of going silent.
    // This is a one-way latch per turn (reset by handleSubmit/handleRegenerate):
    // once true, skip re-scanning message text on every streamed token, since
    // that would otherwise cost O(content length) per tick.
    if (!hasAssistantText) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.type === "ai" && messageText(lastMessage).trim().length > 0) {
        setHasAssistantText(true);
      }
    }
    prevMessageLength.current = messages.length;
  }, [messages, hasAssistantText]);

  // Right panel auto-jump per EXPERIENCE.md "State Patterns": a single-location
  // grounded answer auto-opens the source at that location; a multi-location
  // answer leaves the panel for the user to drive via citation clicks.
  useEffect(() => {
    if (isLoading) return;
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.type !== "ai" || !lastMessage.id) return;
    if (seenAssistantIds.current.has(lastMessage.id)) return;
    seenAssistantIds.current.add(lastMessage.id);

    const text = messageText(lastMessage);
    if (!text.trim()) return;

    const locations = extractCitationLocations(text);
    if (locations.length === 1) {
      openLocation(locations[0]);
    }
  }, [messages, isLoading, openLocation]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (input.trim().length === 0 || isLoading) return;
    setHasAssistantText(false);

    const newHumanMessage: Message = {
      id: uuidv4(),
      type: "human",
      content: [{ type: "text", text: input }],
    };

    const toolMessages = ensureToolCallsHaveResponses(stream.messages);

    stream.submit(
      { messages: [...toolMessages, newHumanMessage] },
      {
        streamMode: ["values"],
        config: { configurable: { book_id: book.id } },
        optimisticValues: (prev) => ({
          ...prev,
          messages: [...(prev.messages ?? []), ...toolMessages, newHumanMessage],
        }),
      },
    );

    setInput("");
  };

  const handleRegenerate = (parentCheckpoint: Checkpoint | null | undefined) => {
    prevMessageLength.current = prevMessageLength.current - 1;
    setHasAssistantText(false);
    stream.submit(undefined, {
      checkpoint: parentCheckpoint,
      streamMode: ["values"],
      config: { configurable: { book_id: book.id } },
    });
  };

  const chatStarted = messages.length > 0;
  const hasNoAIOrToolMessages = !messages.find((m) => m.type === "ai" || m.type === "tool");

  // Intermediate agent steps (e.g. a tool-calling turn with no answer text
  // yet) produce an "ai" message with empty content. AssistantMessage
  // already hides tool-result messages, but it still renders a full
  // (visually blank) message bubble for these text-less ai messages —
  // that blank bubble is the "fallback tool ui" this app intentionally
  // suppresses via hideToolCalls. Drop them here instead, unless a
  // registered generative-UI component is attached to that message id.
  const uiMessageIds = new Set(
    (stream.values.ui ?? [])
      .map((ui) => ui.metadata?.message_id)
      .filter((id): id is string => !!id),
  );
  const visibleMessages = messages.filter((m) => {
    if (m.id?.startsWith(DO_NOT_RENDER_ID_PREFIX)) return false;
    if (m.type !== "ai") return true;
    if (messageText(m).trim().length > 0) return true;
    return !!m.id && uiMessageIds.has(m.id);
  });

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b p-3">
        <p className="truncate text-sm font-medium">{book.title}</p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={showCollection}>
            Collection
          </Button>
          <Button variant="ghost" size="sm" onClick={onNewThread}>
            <SquarePen className="size-4" />
            New conversation
          </Button>
        </div>
      </div>

      <StickToBottom className="relative flex-1 overflow-hidden">
        <StickyToBottomContent
          className={cn(
            "absolute inset-0 overflow-y-scroll px-4 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gray-300 [&::-webkit-scrollbar-track]:bg-transparent",
            !chatStarted && "mt-[10vh] flex flex-col items-stretch",
            chatStarted && "grid grid-rows-[1fr_auto]",
          )}
          contentClassName="pt-8 pb-16 max-w-3xl mx-auto flex flex-col gap-4 w-full"
          content={
            <>
              {!chatStarted && (
                <p className="text-muted-foreground text-center text-sm">
                  Ask a question about <span className="font-medium">{book.title}</span> — a
                  definition, a chapter summary, or something that needs connecting ideas
                  across the book.
                </p>
              )}
              {visibleMessages
                .map((message, index) =>
                  message.type === "human" ? (
                    <HumanMessage
                      key={message.id || `${message.type}-${index}`}
                      message={message}
                      isLoading={isLoading}
                    />
                  ) : (
                    <AssistantMessage
                      key={message.id || `${message.type}-${index}`}
                      message={message}
                      isLoading={isLoading}
                      handleRegenerate={handleRegenerate}
                    />
                  ),
                )}
              {hasNoAIOrToolMessages && !!stream.interrupt && (
                <AssistantMessage
                  key="interrupt-msg"
                  message={undefined}
                  isLoading={isLoading}
                  handleRegenerate={handleRegenerate}
                />
              )}
              {isLoading && !hasAssistantText && <AssistantMessageLoading />}
            </>
          }
          footer={
            <div className="sticky bottom-0 flex flex-col items-center gap-4 bg-white">
              <ScrollToBottom className="animate-in fade-in-0 zoom-in-95 absolute bottom-full left-1/2 mb-4 -translate-x-1/2" />
              <div className="bg-muted relative z-10 mx-auto mb-8 w-full max-w-3xl rounded-2xl border shadow-xs">
                <form onSubmit={handleSubmit} className="mx-auto grid max-w-3xl grid-rows-[1fr_auto] gap-2">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        const el = e.target as HTMLElement | undefined;
                        const form = el?.closest("form");
                        form?.requestSubmit();
                      }
                    }}
                    placeholder="Type your message..."
                    className="field-sizing-content resize-none border-none bg-transparent p-3.5 pb-0 shadow-none ring-0 outline-none focus:ring-0 focus:outline-none"
                  />
                  <div className="flex items-center gap-6 p-2 pt-4">
                    {stream.isLoading ? (
                      <Button key="stop" onClick={() => stream.stop()} className="ml-auto">
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                        Cancel
                      </Button>
                    ) : (
                      <Button type="submit" className="ml-auto shadow-md transition-all" disabled={isLoading || !input.trim()}>
                        Send
                      </Button>
                    )}
                  </div>
                </form>
              </div>
            </div>
          }
        />
      </StickToBottom>
    </div>
  );
}
