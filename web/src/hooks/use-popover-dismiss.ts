import { useEffect, useRef } from "react"

export function usePopoverDismiss(onDismiss: () => void) {
  const ref = useRef(onDismiss)
  ref.current = onDismiss

  useEffect(() => {
    const handler = () => {
      const sel = document.getSelection()
      if (!sel || sel.isCollapsed) {
        // Guard: don't dismiss if focus is inside the popover
        const popover = document.querySelector("[data-popover]")
        if (popover?.contains(document.activeElement)) return
        ref.current()
      }
    }
    document.addEventListener("selectionchange", handler)
    return () => document.removeEventListener("selectionchange", handler)
  }, [])
}
