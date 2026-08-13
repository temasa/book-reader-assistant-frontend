"use client";

import { useEffect, useState } from "react";
import { useQueryState } from "nuqs";
import { useDefaultLayout } from "react-resizable-panels";
import { Toaster } from "@/components/ui/sonner";
import { StreamProvider } from "@/providers/Stream";
import { ThreadProvider } from "@/providers/Thread";
import { RightPanelProvider } from "@/components/right-panel/RightPanelContext";
import { RightPanel } from "@/components/right-panel/RightPanel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { BookThread } from "@/components/thread/BookThread";
import { ArtifactProvider } from "@/components/thread/artifact";
import { getBook, type Book } from "@/lib/books-api";
import { Progress } from "@/components/ui/progress";
import { AlertCircle } from "lucide-react";

const splitLayoutStorage =
  typeof window === "undefined"
    ? { getItem: () => null, setItem: () => {} }
    : {
        getItem: (key: string) => {
          try {
            return window.localStorage.getItem(key);
          } catch {
            return null;
          }
        },
        setItem: (key: string, value: string) => {
          try {
            window.localStorage.setItem(key, value);
          } catch {
            // Storage denied (e.g. private browsing) — split just won't persist.
          }
        },
      };

function threadStorageKey(bookId: string) {
  return `book-thread:${bookId}`;
}

function ThreadIdSync({ bookId }: { bookId: string }) {
  const [threadId, setThreadId] = useQueryState("threadId");

  // Restore this book's last thread on first mount (no threadId in the URL yet).
  useEffect(() => {
    if (threadId) return;
    const stored = window.localStorage.getItem(threadStorageKey(bookId));
    if (stored) setThreadId(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // Persist whenever a thread is created/selected for this book.
  useEffect(() => {
    if (threadId) window.localStorage.setItem(threadStorageKey(bookId), threadId);
  }, [bookId, threadId]);

  return null;
}

function NewThreadButtonBridge({ bookId, children }: { bookId: string; children: (onNew: () => void) => React.ReactNode }) {
  const [, setThreadId] = useQueryState("threadId");
  const onNew = () => {
    window.localStorage.removeItem(threadStorageKey(bookId));
    setThreadId(null);
  };
  return <>{children(onNew)}</>;
}

export function BookConversationClient({ bookId }: { bookId: string }) {
  const [book, setBook] = useState<Book | null>(null);
  const [notFound, setNotFound] = useState(false);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "book-conversation-split",
    panelIds: ["chat", "right-panel"],
    storage: splitLayoutStorage,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const b = await getBook(bookId);
        if (cancelled) return;
        setBook(b);
        if (b.status === "ingesting") {
          timer = setTimeout(poll, 2000);
        }
      } catch {
        if (!cancelled) setNotFound(true);
      }
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bookId]);

  if (notFound) {
    return (
      <div className="flex h-screen w-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <AlertCircle className="size-4" />
        Book not found.
      </div>
    );
  }

  if (!book || book.status === "ingesting") {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center gap-3">
        <p className="text-sm font-medium">Extracting concepts from {book?.title ?? "this book"}…</p>
        {book && <Progress value={book.progress * 100} className="h-1.5 w-48" />}
      </div>
    );
  }

  if (book.status === "failed") {
    return (
      <div className="flex h-screen w-full items-center justify-center gap-2 text-sm text-destructive">
        <AlertCircle className="size-4" />
        Ingestion failed: {book.error}
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <Toaster />
      <ThreadProvider>
        <StreamProvider>
          <ArtifactProvider>
            <RightPanelProvider book={book}>
              <ThreadIdSync bookId={bookId} />
              <ResizablePanelGroup
                orientation="horizontal"
                defaultLayout={defaultLayout}
                onLayoutChanged={onLayoutChanged}
                className="flex-1"
              >
                <ResizablePanel id="chat" defaultSize="70" minSize={360} className="min-w-0">
                  <NewThreadButtonBridge bookId={bookId}>
                    {(onNew) => <BookThread book={book} onNewThread={onNew} />}
                  </NewThreadButtonBridge>
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel
                  id="right-panel"
                  defaultSize="30"
                  minSize={320}
                  maxSize="50%"
                  className="border-l"
                >
                  <RightPanel />
                </ResizablePanel>
              </ResizablePanelGroup>
            </RightPanelProvider>
          </ArtifactProvider>
        </StreamProvider>
      </ThreadProvider>
    </div>
  );
}
