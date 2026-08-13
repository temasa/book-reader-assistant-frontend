// Turns the agent's bracketed location tags (e.g. "[page:12]", "[page:12-45]",
// "[anchor:ch3.xhtml]", optionally followed by a verbatim quote in double quotes, e.g.
// [page:12] "the exact sentence") into markdown links the citation-aware `a` renderer can
// intercept and route to the right panel's document viewer. See EXPERIENCE.md "Assistant
// message with citations".
const LOCATION_TAG = /\[(page:\d+(?:-\d+)?|anchor:[^\]]+)\](?:[ \t]*"([^"\n]{1,240})")?/g;

export const CITATION_SCHEME = "citation://";

// Composite location strings are opaque to every caller except the viewer that parses
// them (DocumentViewer.tsx) — RightPanelContext.openLocation and parseCitationHref both
// keep treating "location" as a plain string, so carrying the quote alongside the page
// needs no interface change anywhere else.
const QUOTE_SEPARATOR = "::q:";

// Kept unencoded here -- the whole composite is percent-encoded exactly once, at the
// href boundary in linkifyCitations. Encoding the quote here too would double-encode it.
function composeLocation(location: string, quote?: string): string {
  return quote ? `${location}${QUOTE_SEPARATOR}${quote}` : location;
}

export function linkifyCitations(text: string): string {
  return text.replace(LOCATION_TAG, (_match, location: string, quote?: string) => {
    const label = location.startsWith("page:")
      ? `p. ${location.split("-")[0].slice("page:".length)}`
      : "source";
    return `[${label}](${CITATION_SCHEME}${encodeURIComponent(composeLocation(location, quote))})`;
  });
}

const LOCATION_SHAPE = new RegExp(
  `^(?:page:\\d+(?:-\\d+)?|anchor:[^:]+)(?:${QUOTE_SEPARATOR}.*)?$`,
);

export function parseCitationHref(href: string): string | null {
  if (!href.startsWith(CITATION_SCHEME)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.slice(CITATION_SCHEME.length));
  } catch {
    return null;
  }
  return LOCATION_SHAPE.test(decoded) ? decoded : null;
}

// Splits a composite location string (as produced by composeLocation/linkifyCitations
// and already fully percent-decoded by parseCitationHref) into its page/anchor part and
// an optional quote. Used by DocumentViewer to find and highlight the cited passage
// without widening any component's props.
export function splitLocationQuote(location: string): { location: string; quote: string | null } {
  const idx = location.indexOf(QUOTE_SEPARATOR);
  if (idx === -1) return { location, quote: null };
  return {
    location: location.slice(0, idx),
    quote: location.slice(idx + QUOTE_SEPARATOR.length),
  };
}

// Agent-generated quotes typically use straight quotes/apostrophes; source documents
// (PDF text layers, EPUB markup) commonly use curly ones. Normalizing both sides before
// comparison avoids that alone breaking an otherwise-exact passage match.
export function normalizeQuoteChars(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

// Extracts every unique location tag (page/anchor part only, no quote) in an assistant
// answer, in order of first appearance. Used to decide auto-jump vs. citation-marker-only
// right panel behavior.
export function extractCitationLocations(text: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const match of text.matchAll(LOCATION_TAG)) {
    const loc = match[1];
    if (!seen.has(loc)) {
      seen.add(loc);
      ordered.push(loc);
    }
  }
  return ordered;
}
