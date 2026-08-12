"use client";

import { Toaster } from "@/components/ui/sonner";
import { BookOpenText } from "lucide-react";
import { BookList } from "@/components/right-panel/BookList";

export default function HomePage() {
  return (
    <div className="flex h-screen w-full overflow-hidden">
      <Toaster />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 border-r p-8 text-center">
        <BookOpenText className="text-muted-foreground size-10" />
        <h1 className="text-xl font-semibold tracking-tight">Book Reader Assistant</h1>
        <p className="text-muted-foreground max-w-sm text-sm">
          Select a ready book from the collection to start a scoped conversation, or upload a
          new PDF or EPUB to get started.
        </p>
      </div>
      <div className="w-full max-w-md border-l">
        <BookList />
      </div>
    </div>
  );
}
