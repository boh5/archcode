import { StrictMode, type ReactNode } from "react";
import { ThemeProvider } from "./hooks/use-theme";

export function AppRoot({ children }: { children: ReactNode }) {
  return <StrictMode><ThemeProvider>{children}</ThemeProvider></StrictMode>;
}
