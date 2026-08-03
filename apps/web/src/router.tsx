import { createBrowserRouter, Outlet } from "react-router-dom";
import { RootLayout } from "./routes/root-layout";
import { HomeRoute } from "./routes/home";
import { ProjectLayout, ProjectRoute } from "./routes/project";
import { ProjectSessionsRoute } from "./routes/project-sessions";
import { ProjectTodosRoute } from "./routes/project-todos";
import { ProjectTodoDetailRoute } from "./routes/project-todo-detail";
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
          { path: "/", element: <HomeRoute /> },
          {
            path: "/projects/:slug",
            element: <ProjectLayout />,
            children: [
              { index: true, element: <ProjectRoute /> },
              { path: "todos", element: <ProjectTodosRoute /> },
              { path: "todos/:todoId", element: <ProjectTodoDetailRoute /> },
              { path: "automations", element: <AutomationsRoute /> },
              { path: "automations/:automationId", element: <AutomationDetailRoute /> },
              { path: "sessions", element: <ProjectSessionsRoute /> },
              { path: "sessions/:sessionId", element: <SessionRoute /> },
            ],
          },
          { path: "*", element: <NotFoundRoute /> },
        ],
      },
    ],
  },
]);
