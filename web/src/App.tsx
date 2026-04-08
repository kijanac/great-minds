import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router";
import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

import { AppShell } from "@/components/app-shell";
import { CornerMenuContainer } from "@/containers/corner-menu-container";
import { AuthProvider, useAuth } from "@/lib/auth";
import HomePage from "@/pages/home";
import LoginPage from "@/pages/login";
import DocPage from "@/pages/doc";
import SessionPage from "@/pages/session";
import SessionsPage from "@/pages/sessions";

const EASE_OUT: [number, number, number, number] = [0.25, 1, 0.5, 1];

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

function AnimatedRoutes() {
  const location = useLocation();
  const prefersReducedMotion = useReducedMotion();
  const isDoc = location.pathname.startsWith("/doc");
  const depth = isDoc ? "deep" : "surface";

  // Entrance-only: no AnimatePresence, old page unmounts instantly.
  // Exit animations would require both pages in the DOM simultaneously.
  return (
    <motion.div
      key={depth}
      initial={prefersReducedMotion ? false : { opacity: 0, y: isDoc ? -8 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: EASE_OUT }}
    >
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
    </motion.div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppShell utility={<CornerMenuContainer />}>
          <AnimatedRoutes />
        </AppShell>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
