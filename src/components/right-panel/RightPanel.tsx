"use client";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Library } from "lucide-react";
import { useRightPanel } from "./RightPanelContext";
import { BookList } from "./BookList";
import { DocumentViewer } from "./DocumentViewer";

export function RightPanel() {
  const { mode, book, location, showCollection } = useRightPanel();
  const title = mode === "collection" ? "Collection" : book.title;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b p-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="min-w-0 truncate text-sm font-medium">{title}</p>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start">
            {title}
          </TooltipContent>
        </Tooltip>
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
