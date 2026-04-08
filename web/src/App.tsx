import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { CornerMenuContainer } from "@/containers/corner-menu-container";
import { AuthProvider, useAuth } from "@/lib/auth";
import HomePage from "@/pages/home";
import LoginPage from "@/pages/login";
import DocPage from "@/pages/doc";
import SessionPage from "@/pages/session";
import SessionsPage from "@/pages/sessions";

function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

function RedirectIfAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (isAuthenticated) return <Navigate to="/" replace />;
  return children;
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppShell utility={<CornerMenuContainer />}>
          <Routes>
            <Route
              path="/login"
              element={
                <RedirectIfAuth>
                  <LoginPage />
                </RedirectIfAuth>
              }
            />
            <Route
              path="/"
              element={
                <RequireAuth>
                  <HomePage />
                </RequireAuth>
              }
            />
            <Route
              path="/doc/*"
              element={
                <RequireAuth>
                  <DocPage />
                </RequireAuth>
              }
            />
            <Route
              path="/sessions"
              element={
                <RequireAuth>
                  <SessionsPage />
                </RequireAuth>
              }
            />
            <Route
              path="/sessions/:id"
              element={
                <RequireAuth>
                  <SessionPage />
                </RequireAuth>
              }
            />
          </Routes>
        </AppShell>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
