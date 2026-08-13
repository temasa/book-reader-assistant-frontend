"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import { bookFileUrl, type Book } from "@/lib/books-api";
import { normalizeQuoteChars, splitLocationQuote } from "@/lib/citations";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

// pdf.js needs its worker as a separate script; bundlers resolve this new URL()
// pattern to a static asset URL at build time (Next/webpack and Turbopack both
// support it) rather than us having to copy the file into /public by hand.
// This module is loaded via next/dynamic({ ssr: false }) from DocumentViewer.tsx --
// pdf.js references browser-only globals (DOMMatrix, etc.) that don't exist during
// Next's server render of "use client" components, so it must never enter the SSR bundle.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

// Passed as <Document options={PDF_OPTIONS}>. Without wasmUrl, pdf.js's JPX
// (JPEG2000) decoder can't initialize -- any image using that codec silently
// fails to decode and its page area is left blank (no onRenderError, since
// per-image decode failures don't fail the whole page render). Memoized as a
// module-level constant (not recreated per render) per react-pdf's own
// warning that a fresh `options` object on every render forces needless
// reloads.
// Unlike workerSrc, wasmUrl must resolve to a directory of *originally*-named
// files (pdf.js appends "openjpeg.wasm" / "qcms_bg.wasm" itself at fetch time),
// which Turbopack's new URL(..., import.meta.url) asset pipeline can't produce --
// it only hashes and copies single referenced files. scripts/copy-pdfjs-wasm.mjs
// (run via predev/prebuild) copies them into public/pdfjs-wasm/ instead, served
// as-is at this fixed path.
const PDF_OPTIONS = { wasmUrl: "/pdfjs-wasm/" };

// How many pages ahead/behind the currently-visible page stay mounted (AD-1).
// Tunable implementation constant, not fixed by the architecture spine.
const LOOKAROUND = 2;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.2;
const DEFAULT_SCALE = 1;
// Used as the placeholder page size before any page has ever loaded (unscaled,
// roughly US-Letter proportions) -- keeps scrollbar proportions sane on first paint.
const FALLBACK_ORIGINAL_WIDTH = 612;
const FALLBACK_ORIGINAL_HEIGHT = 792;

const CITATION_HIGHLIGHT_CLASSES = [
  "citation-highlight",
  "bg-yellow-300/70",
  "dark:bg-yellow-500/40",
  "rounded-sm",
  "ring-2",
  "ring-yellow-400/80",
];
const SEARCH_MATCH_CLASSES = ["search-match", "bg-sky-300/70", "dark:bg-sky-500/40", "rounded-sm"];
const SEARCH_MATCH_CURRENT_CLASSES = ["ring-2", "ring-sky-500"];

// "page:12" -> 12, "page:12-45" -> 12 (jump to the range's first page). This is the
// *cited* page number (what's printed on the page), which front matter (roman
// numerals, an unnumbered cover, ...) commonly makes different from the PDF's
// physical page position -- resolve it through `pageMap` (Book.page_map) to get the
// physical position to render/scroll to. A cited number missing from the map (older
// book ingested before page_map existed, or a page skipped by the map's isdigit()
// fallback) falls back to treating the cited number as a physical position directly,
// same as before page_map existed.
// Returns null (not NaN) for anything unparseable so callers can fall back cleanly.
function pageNumberFromLocation(location: string, pageMap: Record<string, number>): number | null {
  const m = /^page:(\d+)/.exec(location);
  if (!m) return null;
  const cited = m[1];
  const n = pageMap[cited] ?? Number(cited);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// Finds the first text-layer span whose text contains the start of `quote` and
// highlights + scrolls to just that span. MVP scope (per spec): first matching
// line only, not the full passage's bounding box. Silently no-ops if the quote
// can't be found (ligatures/hyphenation/OCR make exact matches unreliable) --
// the page has already been shown, so this is a bonus, not a requirement.
function highlightQuoteInPage(container: HTMLElement, quote: string, shouldScroll: boolean) {
  const needle = normalizeQuoteChars(quote.trim().slice(0, 40).toLowerCase());
  if (!needle) return;
  const spans = Array.from(container.querySelectorAll("span"));
  const match = spans.find((span) => {
    const text = normalizeQuoteChars((span.textContent || "").trim().toLowerCase());
    // pdf.js may render a text-layer span per line or per word depending on the
    // PDF's internal structure, so check both containment directions: the quote
    // inside a longer line-span, or a short word-span inside the quote.
    return text.length > 5 && (text.includes(needle) || needle.includes(text));
  });
  if (!match) return;
  match.classList.add(...CITATION_HIGHLIGHT_CLASSES);
  // onRenderTextLayerSuccess can fire well after the mount that triggered it (slow
  // PDF/image decoding) -- if the user has since made another explicit navigation
  // (jump-to-page, search), don't steal scroll focus back to this citation; the
  // highlight still gets applied so it's visible if/when they scroll back to it.
  if (shouldScroll) match.scrollIntoView({ behavior: "smooth", block: "center" });
}

type SearchMatch = { page: number; order: number };

export default function PdfViewer({ book, location }: { book: Book; location: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const visibleRatiosRef = useRef<Map<number, number>>(new Map());
  const visiblePageRef = useRef(1);
  const prevScaleRef = useRef(DEFAULT_SCALE);
  // Bumped by every explicit navigation (citation jump, jump-to-page, search step).
  // `citationJumpGenRef` snapshots the counter at the moment a citation jump was
  // requested; a citation highlight only steals scroll focus if no *other*
  // navigation has happened since (see highlightQuoteInPage's `shouldScroll`).
  const navGenRef = useRef(0);
  const citationJumpGenRef = useRef(0);
  // Retry count per page the search scan has given after a suspiciously bare
  // "ready" signal (see the search-scan effect) -- reset per search so a fresh
  // query gets a fresh retry budget.
  const scanRetriedPagesRef = useRef<Map<number, number>>(new Map());

  const [error, setError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [visiblePage, setVisiblePage] = useState(1);
  const [forcedPages, setForcedPages] = useState<Set<number>>(() => new Set([1]));
  const [pageOriginalDims, setPageOriginalDims] = useState<
    Map<number, { width: number; height: number }>
  >(new Map());
  const [textReady, setTextReady] = useState<Set<number>>(() => new Set());

  const [jumpInput, setJumpInput] = useState("");

  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [scannedUpTo, setScannedUpTo] = useState(0);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);
  const [pendingAdvance, setPendingAdvance] = useState(false);
  // The single page the search scan is currently force-mounting to read its text
  // layer. Ephemeral (not accumulated like `forcedPages`) -- once a page's spans
  // have been scanned, there's no reason to keep it mounted just because it was
  // visited, so it's free to fall back out of the render window. Accumulating every
  // scanned page instead (as `forcedPages` does for jump targets) would force-mount
  // the entire span walked so far, defeating CAP-2's bounded render-window guarantee
  // and overwhelming pdf.js's single worker on a long walk.
  const [scanCursorPage, setScanCursorPage] = useState<number | null>(null);

  const { location: baseLocation, quote } = location
    ? splitLocationQuote(location)
    : { location: null, quote: null };
  const targetPage = baseLocation ? pageNumberFromLocation(baseLocation, book.page_map) : null;

  useEffect(() => {
    visiblePageRef.current = visiblePage;
  }, [visiblePage]);

  // AD-2: on a location change, force the target page into the render window
  // immediately (never left to IntersectionObserver to discover lazily), then
  // scroll to it. The wrapper <div> for every page exists as soon as numPages
  // is known, regardless of whether that page is currently mounted, so the
  // scroll doesn't have to wait on the force-mount to land.
  useEffect(() => {
    if (targetPage == null || !numPages) return;
    navGenRef.current += 1;
    citationJumpGenRef.current = navGenRef.current;
    const clamped = clamp(targetPage, 1, numPages);
    setForcedPages((prev) => (prev.has(clamped) ? prev : new Set(prev).add(clamped)));
    // Instant, not smooth: a jump can cross hundreds of not-yet-measured placeholder
    // pages, and their heights can still correct slightly as they mount and measure.
    // An in-flight smooth-scroll animation fights that settling and can drift away
    // from the target; landing instantly and letting layout settle first is reliable.
    pageRefs.current.get(clamped)?.scrollIntoView({ behavior: "auto", block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, numPages]);

  // AD-1: IntersectionObserver on each page's wrapper tracks which page is most
  // visible; that drives both the "Page X of N" indicator and the virtualization
  // window (visiblePage +/- LOOKAROUND). A callback only reports entries whose
  // threshold crossed since the last invocation -- not the full currently-visible
  // set -- so ratios are accumulated in a persistent map and "most visible" is
  // recomputed over that whole map, not just the entries in this one callback.
  useEffect(() => {
    if (!numPages || !containerRef.current) return;
    let debounceHandle: number | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pn = Number((entry.target as HTMLElement).dataset.pageNumber);
          if (!pn) continue;
          visibleRatiosRef.current.set(pn, entry.isIntersecting ? entry.intersectionRatio : 0);
        }
        // Debounced: committing visiblePage on every notification changes the mount
        // window mid-scroll, which mounts/unmounts pages and can itself trigger more
        // notifications. Waiting for a short quiet period lets the window settle once
        // per scroll gesture instead of thrashing.
        if (debounceHandle != null) window.clearTimeout(debounceHandle);
        debounceHandle = window.setTimeout(() => {
          let best = visiblePageRef.current;
          let bestRatio = 0;
          visibleRatiosRef.current.forEach((ratio, pn) => {
            if (ratio > bestRatio) {
              bestRatio = ratio;
              best = pn;
            }
          });
          if (bestRatio > 0) setVisiblePage(best);
        }, 100);
      },
      { root: containerRef.current, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    observerRef.current = observer;
    pageRefs.current.forEach((el) => observer.observe(el));
    return () => {
      if (debounceHandle != null) window.clearTimeout(debounceHandle);
      observer.disconnect();
      observerRef.current = null;
    };
  }, [numPages]);

  // React treats a ref callback as "changed" (detach old, attach new) whenever its
  // function identity changes, even if the underlying DOM node didn't. An inline
  // `(el) => ...` created fresh per render would make React re-run detach+attach
  // -- and re-call IntersectionObserver.observe() -- for every mounted page on
  // every render, which floods the observer with fresh notifications and can
  // cascade into a render loop. Caching one stable callback per page number avoids
  // that churn: the ref only actually fires on real mount/unmount.
  const refCallbacksRef = useRef<Map<number, (el: HTMLDivElement | null) => void>>(new Map());
  const getPageRef = useCallback((pageNumber: number) => {
    let cb = refCallbacksRef.current.get(pageNumber);
    if (!cb) {
      cb = (el: HTMLDivElement | null) => {
        if (el) {
          pageRefs.current.set(pageNumber, el);
          observerRef.current?.observe(el);
        } else {
          const prev = pageRefs.current.get(pageNumber);
          if (prev) observerRef.current?.unobserve(prev);
          pageRefs.current.delete(pageNumber);
        }
      };
      refCallbacksRef.current.set(pageNumber, cb);
    }
    return cb;
  }, []);

  const windowSet = useMemo(() => {
    const s = new Set<number>();
    if (numPages) {
      const start = Math.max(1, visiblePage - LOOKAROUND);
      const end = Math.min(numPages, visiblePage + LOOKAROUND);
      for (let p = start; p <= end; p++) s.add(p);
    }
    forcedPages.forEach((p) => s.add(p));
    if (scanCursorPage != null) s.add(scanCursorPage);
    return s;
  }, [visiblePage, numPages, forcedPages, scanCursorPage]);

  // A page that falls out of the render window unmounts its <Page> (discarding
  // pdf.js's rendered text layer); a later remount starts from scratch. Without
  // this, `textReady` would keep believing an unmounted-then-remounted page is
  // still ready from its *previous* mount, and both the citation-highlight and
  // search-scan logic would read an empty/placeholder DOM instead of waiting for
  // the new mount's own onRenderTextLayerSuccess.
  useEffect(() => {
    setTextReady((prev) => {
      let changed = false;
      const next = new Set<number>();
      prev.forEach((p) => {
        if (windowSet.has(p)) {
          next.add(p);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [windowSet]);

  const fallbackDims = useMemo(() => {
    const first = pageOriginalDims.values().next().value;
    return first ?? { width: FALLBACK_ORIGINAL_WIDTH, height: FALLBACK_ORIGINAL_HEIGHT };
  }, [pageOriginalDims]);

  // Placeholder sizing for a not-yet-loaded page prefers the *nearest* already-measured
  // page's dims, not just whichever page happened to load first (usually page 1, a
  // cover -- often a different aspect ratio than body pages). Using a distant/atypical
  // page's dims as the estimate for a whole neighborhood of placeholders means that
  // neighborhood's placeholder heights are all wrong by the same amount; once those
  // pages actually mount and snap to their true size, the layout shift lands right
  // under the viewport and drags scroll position away from wherever the user jumped.
  // Nearby pages are far more likely to share dimensions, keeping that shift small.
  const dimsForPage = useCallback(
    (pageNumber: number) => {
      const exact = pageOriginalDims.get(pageNumber);
      if (exact) return exact;
      let best: { width: number; height: number } | null = null;
      let bestDist = Infinity;
      pageOriginalDims.forEach((dims, pn) => {
        const dist = Math.abs(pn - pageNumber);
        if (dist < bestDist) {
          bestDist = dist;
          best = dims;
        }
      });
      return best ?? fallbackDims;
    },
    [pageOriginalDims, fallbackDims],
  );

  // AD-4: zoom is one numeric `scale` passed to every mounted <Page>, never a CSS
  // transform. Re-scaling shifts every page's pixel height, so re-anchor the
  // scroll position on the page that was visible right before the zoom change.
  useEffect(() => {
    if (prevScaleRef.current === scale) return;
    prevScaleRef.current = scale;
    const pn = visiblePageRef.current;
    requestAnimationFrame(() => {
      pageRefs.current.get(pn)?.scrollIntoView({ behavior: "auto", block: "start" });
    });
  }, [scale]);

  function handleZoom(delta: number) {
    setScale((s) => clamp(Math.round((s + delta) * 100) / 100, MIN_SCALE, MAX_SCALE));
  }
  function handleZoomReset() {
    setScale(DEFAULT_SCALE);
  }

  function handleJumpSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!numPages) return;
    navGenRef.current += 1;
    const n = Number(jumpInput);
    if (!Number.isFinite(n)) return;
    const clamped = clamp(Math.round(n), 1, numPages);
    setForcedPages((prev) => (prev.has(clamped) ? prev : new Set(prev).add(clamped)));
    pageRefs.current.get(clamped)?.scrollIntoView({ behavior: "auto", block: "start" });
    setJumpInput("");
  }

  // AD-5: search reuses each mounted page's rendered text-layer spans rather than
  // pdf.js's getTextContent(). It walks forward page by page, force-mounting only
  // the single page currently being scanned (`scanCursorPage`, not the permanent
  // `forcedPages` registry -- see its declaration) until that page renders, scans
  // its spans, then advances -- buffering roughly one match ahead of the current
  // one at a time and never holding more than one extra page in memory for the walk.
  useEffect(() => {
    if (!searchQuery || !numPages) return;
    const wantAtLeast = currentMatchIndex < 0 ? 1 : currentMatchIndex + 2;
    if (matches.length >= wantAtLeast) return;
    if (scannedUpTo >= numPages) return;
    const nextPage = scannedUpTo + 1;
    if (textReady.has(nextPage) && windowSet.has(nextPage)) {
      const el = pageRefs.current.get(nextPage);
      const spanCount = el ? el.querySelectorAll("span").length : 0;
      // A page's text-layer container always carries at least the struct-tree span
      // plus an `endOfContent` marker once genuinely empty of text (e.g. an
      // image-only cover) -- but under fast mount/unmount churn during this walk,
      // onRenderTextLayerSuccess can fire before react-pdf has actually finished
      // appending real spans to the (freshly re-mounted) DOM container. A page that
      // reports "ready" with a suspiciously bare span count gets a few short
      // retries before it's trusted as genuinely textless, rather than being
      // recorded as a false "no matches here".
      const retries = scanRetriedPagesRef.current.get(nextPage) ?? 0;
      if (spanCount <= 1 && retries < 4) {
        scanRetriedPagesRef.current.set(nextPage, retries + 1);
        const timer = window.setTimeout(() => {
          // Re-trigger this effect without changing what it observes.
          setTextReady((prev) => new Set(prev));
        }, 400);
        return () => window.clearTimeout(timer);
      }
      const needle = normalizeQuoteChars(searchQuery.toLowerCase());
      const found: SearchMatch[] = [];
      if (el) {
        const spans = Array.from(el.querySelectorAll("span"));
        spans.forEach((span, idx) => {
          const text = normalizeQuoteChars((span.textContent || "").toLowerCase());
          if (text && needle && text.includes(needle)) found.push({ page: nextPage, order: idx });
        });
      }
      setMatches((prev) => [...prev, ...found]);
      setScannedUpTo(nextPage);
    } else if (scanCursorPage !== nextPage) {
      setScanCursorPage(nextPage);
    }
  }, [searchQuery, textReady, scannedUpTo, numPages, matches.length, currentMatchIndex, scanCursorPage, windowSet]);

  // Auto-select the first match once it's found.
  useEffect(() => {
    if (currentMatchIndex === -1 && matches.length > 0) setCurrentMatchIndex(0);
  }, [matches.length, currentMatchIndex]);

  // Search-match navigation goes through the same AD-2 "force into window" path as
  // every other jump (Consistency Conventions): the current match's page is added
  // to the permanent `forcedPages` registry (unlike the ephemeral scan cursor above)
  // so it stays mounted for display/highlighting while it's the active match.
  useEffect(() => {
    if (currentMatchIndex < 0 || currentMatchIndex >= matches.length) return;
    const page = matches[currentMatchIndex].page;
    setForcedPages((prev) => (prev.has(page) ? prev : new Set(prev).add(page)));
  }, [currentMatchIndex, matches]);

  // Resolve a pending "next" click once scanning turns up (or rules out) more matches.
  useEffect(() => {
    if (!pendingAdvance) return;
    if (currentMatchIndex + 1 < matches.length) {
      setCurrentMatchIndex((i) => i + 1);
      setPendingAdvance(false);
    } else if (scannedUpTo >= (numPages ?? 0)) {
      // No more matches after the current one -- wrap around if any exist at all.
      if (matches.length > 0) setCurrentMatchIndex(0);
      setPendingAdvance(false);
    }
  }, [pendingAdvance, currentMatchIndex, matches.length, scannedUpTo, numPages]);

  // Apply/clear search-match styling in the DOM whenever matches, the current
  // index, or which pages are text-ready changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.querySelectorAll(`.${SEARCH_MATCH_CLASSES[0]}`).forEach((el) => {
      el.classList.remove(...SEARCH_MATCH_CLASSES, ...SEARCH_MATCH_CURRENT_CLASSES);
    });
    matches.forEach((m, idx) => {
      const el = pageRefs.current.get(m.page);
      if (!el) return;
      const span = el.querySelectorAll("span")[m.order] as HTMLElement | undefined;
      if (!span) return;
      span.classList.add(...SEARCH_MATCH_CLASSES);
      if (idx === currentMatchIndex) {
        span.classList.add(...SEARCH_MATCH_CURRENT_CLASSES);
        // Instant for the same reason as the AD-2 jump scroll above: stepping to a
        // match can force-mount a distant, not-yet-measured page.
        span.scrollIntoView({ behavior: "auto", block: "center" });
      }
    });
  }, [matches, currentMatchIndex, textReady]);

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    navGenRef.current += 1;
    const q = searchInput.trim();
    setSearchQuery(q);
    setMatches([]);
    setScannedUpTo(0);
    setCurrentMatchIndex(-1);
    setPendingAdvance(false);
    setScanCursorPage(null);
    scanRetriedPagesRef.current = new Map();
  }
  function handleSearchClear() {
    setSearchInput("");
    setSearchQuery("");
    setMatches([]);
    setScannedUpTo(0);
    setCurrentMatchIndex(-1);
    setPendingAdvance(false);
    setScanCursorPage(null);
    scanRetriedPagesRef.current = new Map();
  }
  function handleSearchNext() {
    navGenRef.current += 1;
    if (currentMatchIndex + 1 < matches.length) {
      setCurrentMatchIndex((i) => i + 1);
    } else {
      setPendingAdvance(true);
    }
  }
  function handleSearchPrev() {
    navGenRef.current += 1;
    if (currentMatchIndex > 0) setCurrentMatchIndex((i) => i - 1);
    else if (matches.length > 0) setCurrentMatchIndex(matches.length - 1);
  }

  const searchDone = numPages != null && scannedUpTo >= numPages;
  const searchStatus = !searchQuery
    ? null
    : matches.length === 0
      ? searchDone
        ? "No matches"
        : "Searching…"
      : `${currentMatchIndex + 1} / ${matches.length}${searchDone ? "" : "+"}`;

  return (
    <div className="flex h-full w-full flex-col bg-muted/30">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background/95 px-3 py-2 text-sm backdrop-blur">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => handleZoom(-SCALE_STEP)}
            disabled={scale <= MIN_SCALE}
            className="rounded p-1 hover:bg-muted disabled:opacity-40"
            aria-label="Zoom out"
          >
            <ZoomOut className="size-4" />
          </button>
          <span className="w-10 text-center tabular-nums text-muted-foreground">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => handleZoom(SCALE_STEP)}
            disabled={scale >= MAX_SCALE}
            className="rounded p-1 hover:bg-muted disabled:opacity-40"
            aria-label="Zoom in"
          >
            <ZoomIn className="size-4" />
          </button>
          <button
            type="button"
            onClick={handleZoomReset}
            className="rounded p-1 hover:bg-muted"
            aria-label="Reset zoom"
          >
            <RotateCcw className="size-4" />
          </button>
        </div>

        <form onSubmit={handleJumpSubmit} className="flex items-center gap-1">
          <input
            type="number"
            min={1}
            max={numPages ?? undefined}
            value={jumpInput}
            onChange={(e) => setJumpInput(e.target.value)}
            placeholder="Page #"
            className="w-16 rounded border bg-background px-2 py-1 text-xs"
            aria-label="Jump to page"
          />
          <button
            type="submit"
            className="rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40"
            disabled={!numPages}
          >
            Go
          </button>
        </form>

        <span className="text-muted-foreground">
          Page {visiblePage} of {numPages ?? "…"}
        </span>

        <form onSubmit={handleSearchSubmit} className="ml-auto flex items-center gap-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search…"
              className="w-36 rounded border bg-background py-1 pl-7 pr-2 text-xs"
              aria-label="Search document"
            />
          </div>
          {searchQuery && (
            <button
              type="button"
              onClick={handleSearchClear}
              className="rounded p-1 hover:bg-muted"
              aria-label="Clear search"
            >
              <X className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={handleSearchPrev}
            disabled={matches.length === 0}
            className="rounded p-1 hover:bg-muted disabled:opacity-40"
            aria-label="Previous match"
          >
            <ChevronUp className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={handleSearchNext}
            disabled={!searchQuery || (matches.length === 0 && searchDone)}
            className="rounded p-1 hover:bg-muted disabled:opacity-40"
            aria-label="Next match"
          >
            <ChevronDown className="size-3.5" />
          </button>
          {searchStatus && (
            <span className="min-w-[5rem] text-xs text-muted-foreground">{searchStatus}</span>
          )}
        </form>
      </div>

      <div
        ref={containerRef}
        className="relative flex-1 overflow-auto"
        style={{ overflowAnchor: "none" }}
      >
        {error ? (
          <div className="flex h-full items-center justify-center gap-2 text-muted-foreground text-sm">
            <AlertCircle className="size-4" />
            {error}
          </div>
        ) : (
          <Document
            file={bookFileUrl(book.id)}
            options={PDF_OPTIONS}
            loading={
              <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
                Loading document…
              </div>
            }
            onLoadSuccess={(pdf) => setNumPages(pdf.numPages)}
            onLoadError={() => setError("Could not load this PDF.")}
            className="flex flex-col items-center gap-2 py-4"
          >
            {numPages != null &&
              Array.from({ length: numPages }, (_, i) => i + 1).map((pageNumber) => {
                const mounted = windowSet.has(pageNumber);
                const dims = dimsForPage(pageNumber);
                const isJumpTarget = targetPage === pageNumber;
                const jumpGenAtMount = citationJumpGenRef.current;
                return (
                  <div
                    key={pageNumber}
                    ref={getPageRef(pageNumber)}
                    data-page-number={pageNumber}
                    style={
                      !mounted
                        ? { width: dims.width * scale, height: dims.height * scale }
                        : undefined
                    }
                  >
                    {mounted && (
                      <Page
                        key={`${pageNumber}:${isJumpTarget ? (quote ?? "") : ""}`}
                        pageNumber={pageNumber}
                        scale={scale}
                        renderAnnotationLayer={false}
                        onLoadSuccess={(page) => {
                          setPageOriginalDims((prev) => {
                            const next = new Map(prev);
                            next.set(pageNumber, {
                              width: page.originalWidth,
                              height: page.originalHeight,
                            });
                            return next;
                          });
                        }}
                        onRenderTextLayerSuccess={() => {
                          setTextReady((prev) => {
                            if (prev.has(pageNumber)) return prev;
                            return new Set(prev).add(pageNumber);
                          });
                          if (isJumpTarget && quote) {
                            const el = pageRefs.current.get(pageNumber);
                            if (el) {
                              highlightQuoteInPage(el, quote, navGenRef.current === jumpGenAtMount);
                            }
                          }
                        }}
                        onRenderError={() => setError(`Could not render page ${pageNumber}.`)}
                      />
                    )}
                  </div>
                );
              })}
          </Document>
        )}
      </div>
    </div>
  );
}
