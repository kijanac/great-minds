import { CornerMenu } from "@/components/corner-menu";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/hooks/use-theme";

export function CornerMenuContainer() {
  const { isAuthenticated, logout } = useAuth();
  const { theme, toggle } = useTheme();

  if (!isAuthenticated) return null;

  return <CornerMenu theme={theme} onToggleTheme={toggle} onSignOut={logout} />;
}
