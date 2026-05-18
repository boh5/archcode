import { createBrowserRouter } from "react-router-dom";
import { WelcomeRoute } from "./routes/welcome";
import { ProjectRoute } from "./routes/project";
import { SessionRoute } from "./routes/session";
import { NotFoundRoute } from "./routes/not-found";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <WelcomeRoute />,
  },
  {
    path: "/projects/:slug",
    element: <ProjectRoute />,
    children: [
      {
        path: "sessions/:sessionId",
        element: <SessionRoute />,
      },
    ],
  },
  {
    path: "*",
    element: <NotFoundRoute />,
  },
]);