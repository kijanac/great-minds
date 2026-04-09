import type { CSSProperties, ReactNode } from "react";

interface AppShellProps {
  utility?: ReactNode;
  children: ReactNode;
}

export function AppShell({ utility, children }: AppShellProps) {
  const style: CSSProperties & { "--shell-utility-inset": string } = {
    "--shell-utility-inset": utility ? "3.5rem" : "2.5rem",
  };

  return (
    <div className="relative h-screen" style={style}>
      {children}
      {utility && <div className="fixed bottom-4 left-4 z-[100]">{utility}</div>}
    </div>
  );
}
