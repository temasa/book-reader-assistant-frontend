// Turns the agent's bracketed location tags (e.g. "[page:12]", "[anchor:ch3.xhtml]")
// into markdown links the citation-aware `a` renderer can intercept and route to the
// right panel's document viewer. See EXPERIENCE.md "Assistant message with citations".
const LOCATION_TAG = /\[(page:\d+|anchor:[^\]]+)\]/g;

export const CITATION_SCHEME = "citation://";

export function linkifyCitations(text: string): string {
  return text.replace(LOCATION_TAG, (_match, location: string) => {
    const label = location.startsWith("page:")
      ? `p. ${location.slice("page:".length)}`
      : "source";
    return `[${label}](${CITATION_SCHEME}${encodeURIComponent(location)})`;
  });
}

export function parseCitationHref(href: string): string | null {
  if (!href.startsWith(CITATION_SCHEME)) return null;
  return decodeURIComponent(href.slice(CITATION_SCHEME.length));
}

// Extracts every unique location tag in an assistant answer, in order of first
// appearance. Used to decide auto-jump vs. citation-marker-only right panel behavior.
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
