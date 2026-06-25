import { createBrowserRouter, Outlet } from "react-router-dom";
import { RootLayout } from "./routes/root-layout";
import { EmptyState } from "./routes/empty-state";
import { ProjectRoute } from "./routes/project";
import { SessionRoute } from "./routes/session";
import { NotFoundRoute } from "./routes/not-found";
import { AddProjectModalRenderer } from "./context/add-project-modal";
import { SettingsModalRenderer } from "./context/settings-modal";

export const router = createBrowserRouter([
  {
    element: (
      <>
        <AddProjectModalRenderer />
        <SettingsModalRenderer />
        <Outlet />
      </>
    ),
    children: [
      {
        element: <RootLayout />,
        children: [
          { path: "/", element: <EmptyState /> },
          { path: "/projects/:slug", element: <ProjectRoute /> },
          { path: "/projects/:slug/sessions/:sessionId", element: <SessionRoute /> },
          { path: "*", element: <NotFoundRoute /> },
        ],
      },
    ],
  },
]);
