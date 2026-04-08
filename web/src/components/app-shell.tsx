import type { ReactNode } from "react"

interface AppShellProps {
  utility?: ReactNode
  children: ReactNode
}

export function AppShell({ utility, children }: AppShellProps) {
  return (
    <div className="relative h-screen" style={{ "--shell-utility-inset": utility ? "3.5rem" : "2.5rem" } as React.CSSProperties}>
      {children}
      {utility && (
        <div className="fixed bottom-4 left-4 z-[100]">
          {utility}
        </div>
      )}
    </div>
  )
}
