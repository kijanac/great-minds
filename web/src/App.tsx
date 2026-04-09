import { createBrowserRouter, Navigate, Outlet, RouterProvider } from "react-router";

import { AppShell } from "@/components/app-shell";
import { CornerMenuContainer } from "@/containers/corner-menu-container";
import { AuthProvider, useAuth } from "@/lib/auth";
import HomePage from "@/pages/home";
import LoginPage from "@/pages/login";
import DocPage, { docLoader } from "@/pages/doc";
import ProjectSettingsPage from "@/pages/project-settings";
import SessionPage from "@/pages/session";
import SessionsPage from "@/pages/sessions";

function RootLayout() {
  return (
    <AuthProvider>
      <AppShell utility={<CornerMenuContainer />}>
        <Outlet />
      </AppShell>
    </AuthProvider>
  );
}

function RequireAuth() {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function RedirectIfAuth() {
  const { isAuthenticated } = useAuth();
  if (isAuthenticated) return <Navigate to="/" replace />;
  return <Outlet />;
}

const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      {
        element: <RedirectIfAuth />,
        children: [{ path: "/login", element: <LoginPage /> }],
      },
      {
        element: <RequireAuth />,
        children: [
          { path: "/", element: <HomePage /> },
          {
            path: "/doc/*",
            element: <DocPage />,
            loader: docLoader,
          },
          { path: "/project/:id/settings", element: <ProjectSettingsPage /> },
          { path: "/sessions", element: <SessionsPage /> },
          { path: "/sessions/:id", element: <SessionPage /> },
        ],
      },
    ],
  },
]);

function App() {
  return <RouterProvider router={router} />;
}

export default App;
