import { useEffect } from "react"

export function usePopoverDismiss(onDismiss: () => void) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest("[data-popover]")) onDismiss()
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [onDismiss])
}
