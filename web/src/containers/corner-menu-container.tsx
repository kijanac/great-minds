import { CornerMenu } from "@/components/corner-menu";
import { useTheme } from "@/hooks/use-theme";

export function CornerMenuContainer() {
  const { theme, toggle } = useTheme();

  return <CornerMenu theme={theme} onToggleTheme={toggle} />;
}
