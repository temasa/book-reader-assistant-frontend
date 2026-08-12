import React from "react";
import { BookConversationClient } from "./BookConversationClient";

export default async function BookConversationPage({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = await params;
  return (
    <React.Suspense fallback={<div className="p-8">Loading…</div>}>
      <BookConversationClient bookId={bookId} />
    </React.Suspense>
  );
}
