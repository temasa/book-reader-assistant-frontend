"use client";

import { useEffect, useRef, useState } from "react";
import ePub, { type Rendition } from "epubjs";
import { bookFileUrl, type Book } from "@/lib/books-api";
import { AlertCircle } from "lucide-react";

function locationToPdfFragment(location: string): string {
  if (location.startsWith("page:")) {
    return `#page=${location.slice("page:".length)}`;
  }
  return "";
}

function PdfViewer({ book, location }: { book: Book; location: string | null }) {
  const fragment = location ? locationToPdfFragment(location) : "";
  return (
    <iframe
      key={fragment} // force reload so the browser re-seeks to the new page fragment
      title={book.title}
      src={`${bookFileUrl(book.id)}${fragment}`}
      className="h-full w-full border-0"
    />
  );
}

function EpubViewer({ book, location }: { book: Book; location: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const epubBook = ePub(bookFileUrl(book.id));
    const rendition = epubBook.renderTo(containerRef.current, {
      width: "100%",
      height: "100%",
    });
    renditionRef.current = rendition;
    rendition.display().catch(() => setError("Could not render this EPUB."));
    return () => {
      rendition.destroy();
      epubBook.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  useEffect(() => {
    if (!location || !renditionRef.current) return;
    const href = location.startsWith("anchor:")
      ? location.slice("anchor:".length)
      : location;
    renditionRef.current.display(href).catch(() => setError("Source unavailable."));
  }, [location]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted-foreground text-sm">
        <AlertCircle className="size-4" />
        {error}
      </div>
    );
  }
  return <div ref={containerRef} className="h-full w-full" />;
}

export function DocumentViewer({
  book,
  location,
}: {
  book: Book;
  location: string | null;
}) {
  if (book.file_type === "pdf") {
    return <PdfViewer book={book} location={location} />;
  }
  return <EpubViewer book={book} location={location} />;
}
