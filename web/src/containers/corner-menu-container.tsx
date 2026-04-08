import { CornerMenu } from "@/components/corner-menu"
import { useAuth } from "@/lib/auth"

export function CornerMenuContainer() {
  const { isAuthenticated, logout } = useAuth()

  if (!isAuthenticated) return null

  return <CornerMenu onSignOut={logout} />
}
