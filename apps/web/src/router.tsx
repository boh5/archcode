import { createBrowserRouter, Outlet } from "react-router-dom";
import { RootLayout } from "./routes/root-layout";
import { Dashboard } from "./routes/dashboard";
import { ProjectRoute } from "./routes/project";
import { ProjectTodosRoute } from "./routes/project-todos";
import { SessionRoute } from "./routes/session";
import { AutomationsRoute } from "./routes/automations";
import { AutomationDetailRoute } from "./routes/automation-detail";
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
          { path: "/", element: <Dashboard /> },
          { path: "/projects/:slug", element: <ProjectRoute /> },
          { path: "/projects/:slug/todos", element: <ProjectTodosRoute /> },
          { path: "/projects/:slug/automations", element: <AutomationsRoute /> },
          { path: "/projects/:slug/automations/:automationId", element: <AutomationDetailRoute /> },
          { path: "/projects/:slug/sessions/:sessionId", element: <SessionRoute /> },
          { path: "*", element: <NotFoundRoute /> },
        ],
      },
    ],
  },
]);
