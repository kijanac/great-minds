import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

let _nextId = 0
export function genId(prefix: string) {
  return `${prefix}-${++_nextId}`
}

export function slugToTitle(slug: string): string {
  return slug
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")
}

export function simulateStream(
  fullText: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  speed = 4,
  intervalMs = 14,
): () => void {
  let i = 0
  const iv = setInterval(() => {
    i += speed
    onChunk(fullText.slice(0, i))
    if (i >= fullText.length) {
      clearInterval(iv)
      onChunk(fullText)
      onDone()
    }
  }, intervalMs)
  return () => clearInterval(iv)
}
