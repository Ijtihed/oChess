import { Component } from "react";

/**
 * Top-level error boundary.
 *
 * React surfaces render-time errors as exceptions that propagate
 * up the tree until they hit a boundary. Without one, the entire
 * <App /> unmounts and the user sees a white screen - the worst
 * possible failure mode mid-game.
 *
 * This boundary wraps the whole router. The fallback intentionally
 * stays minimal (no Tailwind utilities that depend on the app's
 * design tokens loading correctly) so it renders even if something
 * weird is going on with CSS.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // Always log render errors to the console so prod crash reports
    // (and any future Sentry-style integration) can pick them up.
    // Intentionally not gated by makeLogger - these are real errors.
    // eslint-disable-next-line no-console
    console.error("[oChess] render error:", error, info?.componentStack);
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  reload = () => {
    if (typeof window !== "undefined") window.location.href = "/";
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const message = this.state.error?.message || "An unexpected error occurred.";

    return (
      <div
        role="alert"
        aria-live="assertive"
        style={{
          minHeight: "100dvh",
          backgroundColor: "#0c0c0c",
          color: "#e2e2e2",
          fontFamily: "system-ui, sans-serif",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
        }}
      >
        <div style={{ maxWidth: 480, textAlign: "center" }}>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 800, letterSpacing: "-0.02em", margin: 0, marginBottom: 8 }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 13, color: "#9ca3af", margin: 0, marginBottom: 16, lineHeight: 1.5 }}>
            oChess hit an unexpected error and stopped. The page will still load if you reload, and
            your saved games + analysis are stored locally so they're safe.
          </p>
          <pre
            style={{
              fontSize: 11,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              color: "#6b7280",
              background: "#171717",
              border: "1px solid rgba(255,255,255,0.04)",
              padding: "0.75rem",
              textAlign: "left",
              overflow: "auto",
              maxHeight: 160,
              borderRadius: 0,
              margin: 0,
              marginBottom: 16,
              whiteSpace: "pre-wrap",
            }}
          >
            {String(message)}
          </pre>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button
              onClick={this.reset}
              style={{
                padding: "0.5rem 1rem",
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                background: "transparent",
                color: "#e2e2e2",
                border: "1px solid rgba(255,255,255,0.08)",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              onClick={this.reload}
              style={{
                padding: "0.5rem 1rem",
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                background: "#ffffff",
                color: "#2f3131",
                border: "1px solid #ffffff",
                cursor: "pointer",
              }}
            >
              Reload home
            </button>
          </div>
        </div>
      </div>
    );
  }
}
