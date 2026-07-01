import { createBrowserRouter, Outlet } from "react-router-dom";
import { RootLayout } from "./routes/root-layout";
import { Dashboard } from "./routes/dashboard";
import { ProjectRoute } from "./routes/project";
import { SessionRoute } from "./routes/session";
import { GoalsRoute } from "./routes/goals";
import { GoalDetailRoute } from "./routes/goal-detail";
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
          { path: "/projects/:slug/goals", element: <GoalsRoute /> },
          { path: "/projects/:slug/goals/:goalId", element: <GoalDetailRoute /> },
          { path: "/projects/:slug/sessions/:sessionId", element: <SessionRoute /> },
          { path: "*", element: <NotFoundRoute /> },
        ],
      },
    ],
  },
]);
