"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import ePub, { type Rendition } from "epubjs";
import type Navigation from "epubjs/types/navigation";
import { bookFileUrl, type Book } from "@/lib/books-api";
import { normalizeQuoteChars, splitLocationQuote } from "@/lib/citations";
import { AlertCircle } from "lucide-react";

const EPUB_HIGHLIGHT_CLASS = "citation-highlight";
const EPUB_HIGHLIGHT_STYLES = { fill: "#facc15", "fill-opacity": "0.4" };

// Finds the first text node (across the currently rendered section(s)) containing the
// start of `quote` and returns an epubjs CFI range for it, or null if unmatched. MVP
// scope (per spec): only matches quotes that fit within a single text node -- same
// "first matching line" simplification as the PDF viewer, not a full passage range.
function findQuoteCfiRange(rendition: Rendition, quote: string): string | null {
  const needle = normalizeQuoteChars(quote.trim().slice(0, 200).toLowerCase()).slice(0, 60);
  if (!needle) return null;
  // epubjs's type declarations claim getContents() returns a single Contents, but the
  // runtime implementation (rendition.js) always returns an array (possibly empty) --
  // typed as `any` here to bridge that declaration/runtime mismatch.
  const contentsList: any = rendition.getContents();
  const contentsArr: any[] = Array.isArray(contentsList) ? contentsList : [contentsList];
  for (const contents of contentsArr) {
    const doc = contents?.document;
    if (!doc?.body) continue;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const raw = node.textContent || "";
      const text = normalizeQuoteChars(raw.toLowerCase());
      const idx = text.indexOf(needle);
      if (idx === -1) continue;
      const range = doc.createRange();
      range.setStart(node, idx);
      range.setEnd(node, Math.min(idx + needle.length, raw.length));
      try {
        return contents.cfiFromRange(range);
      } catch {
        return null;
      }
    }
  }
  return null;
}

// pdf.js references browser-only globals (DOMMatrix, etc.) that don't exist during
// Next's server render, so the PDF viewer must be excluded from the SSR bundle.
const PdfViewer = dynamic(() => import("./PdfViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
      Loading document…
    </div>
  ),
});

// AD-6: resolve the current chapter/section title from the rendition's `relocated`
// href against the book's navigation TOC -- no synthesized page numbers for EPUB.
// TOC hrefs are matched exactly first; `relocated`'s href can come back resolved
// slightly differently (e.g. without a redundant "./" prefix) than the TOC's raw
// href, so fall back to matching by filename (ignoring any #fragment) before
// giving up and leaving the previous title in place.
function resolveChapterTitle(navigation: Navigation, href: string): string | null {
  if (!href) return null;
  const clean = href.split("#")[0];
  const direct = navigation.get(href) ?? navigation.get(clean);
  if (direct?.label) return direct.label.trim();

  const filename = clean.split("/").pop();
  if (!filename) return null;
  const flat: { href: string; label: string }[] = [];
  const walk = (items: Navigation["toc"]) => {
    for (const item of items) {
      flat.push(item);
      if (item.subitems?.length) walk(item.subitems);
    }
  };
  walk(navigation.toc);
  const found = flat.find((item) => item.href.split("#")[0].split("/").pop() === filename);
  return found?.label.trim() ?? null;
}

function EpubViewer({ book, location }: { book: Book; location: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const navigationRef = useRef<Navigation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chapterTitle, setChapterTitle] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    // bookFileUrl has no ".epub" extension (it's an API route: /books/{id}/file), so
    // epubjs's own extension-sniffing misdetects it as an unpacked directory and 404s
    // trying to fetch individual files relative to it -- force archive mode explicitly.
    const epubBook = ePub(bookFileUrl(book.id), { openAs: "epub" });
    // AD-3: single rendition-construction site; `scrolled-doc` flow makes the EPUB
    // scroll continuously (CAP-5) instead of paginating. `display()`/CFI-targeting
    // calls below are unaffected -- `scrolled-doc` still honors them.
    const rendition = epubBook.renderTo(containerRef.current, {
      width: "100%",
      height: "100%",
      flow: "scrolled-doc",
    });
    renditionRef.current = rendition;
    rendition.display().catch(() => setError("Could not render this EPUB."));

    epubBook.loaded.navigation.then((nav) => {
      navigationRef.current = nav;
    });

    const handleRelocated = (loc: { start?: { href?: string } }) => {
      const href = loc?.start?.href;
      const nav = navigationRef.current;
      if (!href || !nav) return;
      const title = resolveChapterTitle(nav, href);
      if (title) setChapterTitle(title);
    };
    rendition.on("relocated", handleRelocated);

    return () => {
      rendition.off("relocated", handleRelocated);
      rendition.destroy();
      epubBook.destroy();
    };
  }, [book.id]);

  useEffect(() => {
    if (!location || !renditionRef.current) return;
    const rendition = renditionRef.current;
    const { location: baseLocation, quote } = splitLocationQuote(location);
    const href = baseLocation.startsWith("anchor:")
      ? baseLocation.slice("anchor:".length)
      : baseLocation;
    // Guards the async chain below against a stale/superseded navigation: if `location`
    // changes again (e.g. the collection's citation-1 auto-jump landing after the user
    // has already clicked a later citation, or React StrictMode's dev-only double effect
    // invocation) before this chain finishes, its cleanup flips `cancelled` so the old
    // chain's continuation becomes a no-op instead of racing the new one. Without this,
    // the manager's `display()` destroys the whole view (and any pane/highlight on it)
    // whenever it switches to a not-yet-visible section -- so a superseded effect's
    // in-flight `annotations.highlight()`/`display(cfiRange)` calls interleaving with a
    // newer effect's `display()` can silently wipe out the highlight that was just added.
    let cancelled = false;
    rendition
      .display(href)
      .then(() => {
        if (cancelled || !quote) return;
        // Graceful degradation (CAP-5): if the quote can't be found, the section is
        // already displayed from the line above -- highlighting is a bonus, not required.
        const cfiRange = findQuoteCfiRange(rendition, quote);
        if (!cfiRange) return;
        // Re-display at the exact CFI FIRST, then add the highlight -- display() can
        // clear/redraw the view when switching to a not-yet-visible target (even the
        // same section, by CFI rather than href), which would silently wipe out a mark
        // added beforehand. Highlighting after the view has settled avoids that.
        return rendition.display(cfiRange).then(() => {
          if (cancelled) return;
          rendition.annotations.highlight(
            cfiRange,
            {},
            undefined,
            EPUB_HIGHLIGHT_CLASS,
            EPUB_HIGHLIGHT_STYLES,
          );
        });
      })
      .catch(() => {
        if (!cancelled) setError("Source unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, [location]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted-foreground text-sm">
        <AlertCircle className="size-4" />
        {error}
      </div>
    );
  }
  return (
    <div className="flex h-full w-full flex-col">
      {chapterTitle && (
        <div className="sticky top-0 z-10 truncate border-b bg-background/95 px-3 py-2 text-sm text-muted-foreground backdrop-blur">
          {chapterTitle}
        </div>
      )}
      <div ref={containerRef} className="min-h-0 w-full flex-1" />
    </div>
  );
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
