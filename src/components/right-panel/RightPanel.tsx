"use client";

import { Button } from "@/components/ui/button";
import { Library } from "lucide-react";
import { useRightPanel } from "./RightPanelContext";
import { BookList } from "./BookList";
import { DocumentViewer } from "./DocumentViewer";

export function RightPanel() {
  const { mode, book, location, showCollection } = useRightPanel();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b p-3">
        <p className="truncate text-sm font-medium">
          {mode === "collection" ? "Collection" : book.title}
        </p>
        {mode === "contextual" && (
          <Button variant="ghost" size="sm" onClick={showCollection}>
            <Library className="size-4" />
            Collection
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {mode === "collection" ? (
          <BookList />
        ) : (
          <DocumentViewer book={book} location={location} />
        )}
      </div>
    </div>
  );
}
