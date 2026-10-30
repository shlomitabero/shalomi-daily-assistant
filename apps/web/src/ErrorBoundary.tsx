import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Round 1299: the one place in this app that already anticipated a crash
 * here (BuildProgress.tsx's own "with no ErrorBoundary to catch it"
 * comment) never got one -- an uncaught render-time exception ANYWHERE in
 * the tree (EntityPanel, CalendarView, GlobalSearchPanel, any future
 * component) unmounted the whole React tree to a blank white page with no
 * recovery path and no message, the standard React failure mode this
 * class component exists to prevent.
 *
 * Deliberately wraps <App/> from the OUTSIDE in main.tsx, above both of
 * App's own providers (ThemeProvider/LanguageProvider) -- so if either
 * provider itself is what throws, this still catches it. That also means
 * the fallback below can't call useTranslation() (no LanguageProvider
 * above it, and no hooks in a class component either), so its text is
 * plain, hardcoded Hebrew+English together rather than routed through
 * i18n -- the one case in this codebase where that's the correct
 * choice, not an oversight.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Uncaught error in the app's render tree:", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }
    return (
      <div className="app-crash-fallback">
        <p className="error banner" role="alert">
          משהו השתבש / Something went wrong.
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          רענון הדף / Reload the page
        </button>
      </div>
    );
  }
}
