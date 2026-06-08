import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { createBrowserRouter, Navigate, Outlet, RouterProvider } from "react-router";

import { AppShell } from "@/components/app-shell";
import { CornerMenuContainer } from "@/containers/corner-menu-container";
import { queryClient } from "@/lib/query-client";
import { LocalAppProvider } from "@/local/app-provider";
import VaultNewPage from "@/pages/vault-new";
import HomePage from "@/pages/home";
import DocPage from "@/pages/doc";
import { docLoader } from "@/pages/doc-loader";
import ExplorePage from "@/pages/explore";
import ProjectSettingsPage from "@/pages/project-settings";
import SessionPage from "@/pages/session";
import SessionsPage from "@/pages/sessions";
import SourcesPage from "@/pages/sources";
import WikiPage from "@/pages/wiki";
import PipelinePage from "@/pages/pipeline";

function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <LocalAppProvider>
        <AppShell utility={<CornerMenuContainer />}>
          <Outlet />
        </AppShell>
        {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
      </LocalAppProvider>
    </QueryClientProvider>
  );
}

const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: "/login", element: <Navigate to="/" replace /> },
      { path: "/", element: <HomePage /> },
      { path: "/vaults/new", element: <VaultNewPage /> },
      {
        path: "/doc/*",
        element: <DocPage />,
        loader: docLoader,
      },
      { path: "/explore", element: <ExplorePage /> },
      { path: "/sources", element: <SourcesPage /> },
      { path: "/wiki", element: <WikiPage /> },
      { path: "/pipeline", element: <PipelinePage /> },
      { path: "/pipeline/runs/:jobId", element: <PipelinePage /> },
      { path: "/project/:id/settings", element: <ProjectSettingsPage /> },
      { path: "/sessions", element: <SessionsPage /> },
      { path: "/sessions/:id", element: <SessionPage /> },
    ],
  },
]);

function App() {
  return <RouterProvider router={router} />;
}

export default App;
