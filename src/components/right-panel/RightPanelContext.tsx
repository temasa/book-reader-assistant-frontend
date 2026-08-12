"use client";

import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from "react";
import type { Book } from "@/lib/books-api";

export type RightPanelMode = "collection" | "contextual";

interface RightPanelState {
  mode: RightPanelMode;
  location: string | null;
}

interface RightPanelContextType extends RightPanelState {
  book: Book;
  showCollection: () => void;
  openLocation: (location: string) => void;
}

const RightPanelContext = createContext<RightPanelContextType | undefined>(
  undefined,
);

export function RightPanelProvider({
  book,
  children,
}: {
  book: Book;
  children: ReactNode;
}) {
  const [state, setState] = useState<RightPanelState>({
    mode: "collection",
    location: null,
  });

  const showCollection = useCallback(
    () => setState({ mode: "collection", location: null }),
    [],
  );
  const openLocation = useCallback(
    (location: string) => setState({ mode: "contextual", location }),
    [],
  );

  // Citation links rendered deep inside react-markdown call this via a window hook
  // (see markdown-text.tsx) rather than threading a callback through the vendored
  // agent-chat-ui component tree.
  useEffect(() => {
    (window as any).__onCitationClick = openLocation;
    return () => {
      delete (window as any).__onCitationClick;
    };
  }, [openLocation]);

  return (
    <RightPanelContext.Provider
      value={{ ...state, book, showCollection, openLocation }}
    >
      {children}
    </RightPanelContext.Provider>
  );
}

export function useRightPanel() {
  const ctx = useContext(RightPanelContext);
  if (!ctx) throw new Error("useRightPanel must be used within RightPanelProvider");
  return ctx;
}
