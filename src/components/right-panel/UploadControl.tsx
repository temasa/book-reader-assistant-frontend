"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import { uploadBook } from "@/lib/books-api";
import { toast } from "sonner";

const ACCEPTED = [".pdf", ".epub"];

export function UploadControl({ onUploaded }: { onUploaded: () => void }) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
      if (!ACCEPTED.includes(ext)) {
        toast.error("Only .pdf and .epub files are supported");
        return;
      }
      setUploading(true);
      try {
        const book = await uploadBook(file);
        onUploaded();
        router.push(`/books/${book.id}`);
      } catch {
        toast.error("Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [onUploaded, router],
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center transition-colors",
        dragOver
          ? "border-primary bg-primary/5"
          : "border-border hover:border-primary/40 hover:bg-muted/50",
      )}
    >
      <UploadCloud
        className={cn(
          "size-6 transition-colors",
          dragOver
            ? "text-primary"
            : "text-muted-foreground group-hover:text-primary/70",
        )}
      />
      <p className="text-sm font-medium">
        {uploading ? "Uploading…" : "Upload a book"}
      </p>
      <p className="text-muted-foreground text-xs">PDF or EPUB, drag or click</p>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED.join(",")}
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}
