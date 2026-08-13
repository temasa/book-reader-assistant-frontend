"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Progress } from "@/components/ui/progress";
import { Card } from "@/components/ui/card";
import { FileText, BookOpenText, AlertCircle } from "lucide-react";
import { listBooks, type Book } from "@/lib/books-api";
import { UploadControl } from "./UploadControl";
import { cn } from "@/lib/utils";

function StatusBadge({ book }: { book: Book }) {
  if (book.status === "ready") {
    return <span className="text-xs text-muted-foreground">ready</span>;
  }
  if (book.status === "failed") {
    return (
      <span className="flex items-center gap-1 text-xs text-destructive">
        <AlertCircle className="size-3" />
        failed{book.error ? `: ${book.error}` : ""}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Progress value={book.progress * 100} className="h-1.5 w-20" />
      <span className="text-xs text-muted-foreground">ingesting…</span>
    </div>
  );
}

export function BookList() {
  const [books, setBooks] = useState<Book[]>([]);
  const pathname = usePathname();

  const refresh = useCallback(() => {
    listBooks().then(setBooks).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      // Cheap poll for ingestion progress — fine at prototype scale, no websocket needed.
      setBooks((prev) => {
        if (prev.some((b) => b.status === "ingesting")) refresh();
        return prev;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <UploadControl onUploaded={refresh} />
      {books.length === 0 && (
        <p className="text-muted-foreground text-center text-sm">
          No books yet — upload one to get started.
        </p>
      )}
      <div className="flex flex-col gap-2">
        {books.map((book) => {
          const isActive = pathname === `/books/${book.id}`;
          const clickable = book.status === "ready";
          const content = (
            <Card
              className={cn(
                "flex flex-row items-center gap-3 p-3 transition-all",
                clickable
                  ? "cursor-pointer hover:border-primary/40 hover:shadow-sm"
                  : "opacity-70",
                isActive && "border-primary bg-primary/5 ring-1 ring-primary/20",
              )}
            >
              {book.file_type === "pdf" ? (
                <FileText
                  className={cn(
                    "size-5 shrink-0",
                    isActive ? "text-primary" : "text-muted-foreground",
                  )}
                />
              ) : (
                <BookOpenText
                  className={cn(
                    "size-5 shrink-0",
                    isActive ? "text-primary" : "text-muted-foreground",
                  )}
                />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="truncate text-sm font-medium" title={book.title}>
                  {book.title}
                </p>
                <StatusBadge book={book} />
              </div>
            </Card>
          );
          return clickable ? (
            <Link key={book.id} href={`/books/${book.id}`}>
              {content}
            </Link>
          ) : (
            <div key={book.id}>{content}</div>
          );
        })}
      </div>
    </div>
  );
}
