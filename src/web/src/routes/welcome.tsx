import { useNavigate } from "react-router-dom";

export function WelcomeRoute() {
  const navigate = useNavigate();

  return (
    <div className="flex h-screen items-center justify-center bg-bg-base">
      <div className="flex flex-col items-center gap-6">
        <h1 className="text-3xl font-semibold text-text-primary tracking-tight">
          Welcome to Specra
        </h1>
        <p className="text-text-secondary text-sm max-w-md text-center leading-relaxed">
          Your AI-powered coding agent. Add a project to get started.
        </p>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white
                     transition-colors hover:bg-accent-hover focus:outline-none
                     focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
                     focus-visible:ring-offset-bg-base"
        >
          Add Project
        </button>
      </div>
    </div>
  );
}