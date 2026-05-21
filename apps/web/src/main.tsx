import { StrictMode } from "react";
import { QueryClient, QueryCache, MutationCache, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { ApiError } from "./api/client";
import { ErrorBoundary } from "./components/composite/ErrorBoundary";
import { ToastContainer } from "./components/composite/Toast";
import { AddProjectModalProvider } from "./context/add-project-modal";
import { GlobalSSEProvider } from "./context/global-sse";
import { useToast } from "./hooks/use-toast";
import { router } from "./router";
import "./styles/globals.css";

type ToastCallback = (message: string, variant: "error" | "success" | "warning" | "info") => void;

let globalToast: ToastCallback = () => {};

export function setGlobalToastCallback(cb: ToastCallback) {
  globalToast = cb;
}

function handleQueryError(error: unknown) {
  if (error instanceof ApiError && error.status >= 500) {
    globalToast(error.message, "error");
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
  queryCache: new QueryCache({ onError: handleQueryError }),
  mutationCache: new MutationCache({ onError: handleQueryError }),
});

function App() {
  const { toasts, show, dismiss } = useToast();

  setGlobalToastCallback(show);

  return (
    <QueryClientProvider client={queryClient}>
      <GlobalSSEProvider>
        <AddProjectModalProvider>
          <ErrorBoundary>
            <RouterProvider router={router} />
          </ErrorBoundary>
          <ToastContainer toasts={toasts} onDismiss={dismiss} />
        </AddProjectModalProvider>
      </GlobalSSEProvider>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);