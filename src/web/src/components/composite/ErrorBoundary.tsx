import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught render error:", error, info.componentStack);
  }

  private handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 bg-bg-base text-text-primary">
        <div className="flex flex-col items-center gap-3 max-w-md text-center">
          <div className="w-12 h-12 rounded-full bg-error-muted flex items-center justify-center text-error text-xl font-bold">
            !
          </div>
          <h1 className="text-lg font-semibold text-text-primary">
            Something went wrong
          </h1>
          <p className="text-sm text-text-secondary">
            An unexpected error occurred. Please try reloading the page.
          </p>
          {this.state.error && (
            <pre className="mt-2 px-3 py-2 rounded-md bg-bg-elevated border border-border-default text-xs text-text-tertiary overflow-auto max-w-full text-left font-mono">
              {this.state.error.message}
            </pre>
          )}
        </div>
        <button
          type="button"
          onClick={this.handleReload}
          className="mt-2 px-4 py-2 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer"
        >
          Reload
        </button>
      </div>
    );
  }
}