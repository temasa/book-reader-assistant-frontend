export interface Chapter {
  id: string;
  title: string;
  start_location: string;
}

export interface Book {
  id: string;
  title: string;
  filename: string;
  file_type: "pdf" | "epub";
  status: "ingesting" | "ready" | "failed";
  error: string | null;
  progress: number;
  created_at: string;
  chapters: Chapter[];
  // PDF only: cited page number (the "N" in "page:N" citation tags) -> 1-based
  // physical page position in the rendered PDF. Front matter (roman numerals, an
  // unnumbered cover, ...) commonly makes the printed page number diverge from the
  // page's physical position, so a citation's page must be resolved through this map
  // rather than treated as a physical position directly. Empty for EPUBs and for
  // books ingested before this field existed.
  page_map: Record<string, number>;
}

const BASE_URL =
  process.env.NEXT_PUBLIC_BOOK_SERVICE_URL || "http://localhost:8000";

export async function listBooks(): Promise<Book[]> {
  const res = await fetch(`${BASE_URL}/books`, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to list books");
  return res.json();
}

export async function getBook(bookId: string): Promise<Book> {
  const res = await fetch(`${BASE_URL}/books/${bookId}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to fetch book");
  return res.json();
}

export async function uploadBook(file: File): Promise<Book> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE_URL}/books`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error("Failed to upload book");
  return res.json();
}

export function bookFileUrl(bookId: string): string {
  return `${BASE_URL}/books/${bookId}/file`;
}
