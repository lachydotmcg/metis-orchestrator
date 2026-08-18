import React from "react";

/** The last thing between a thrown render and a blank page.
 *
 *  There was no error boundary anywhere in this renderer, which means every
 *  render-time throw unmounted the entire tree and left `#root` empty — no
 *  sidebar, no message, no hint that anything had happened. That is the worst
 *  failure a UI can have, because it is indistinguishable from "the app did not
 *  load" and it sends you looking at the wrong layer.
 *
 *  Found by serving the browser client a deliberately wrong shape: one route
 *  returning null instead of a `PulseFeed` destroyed a non-null fallback in the
 *  titlebar, and the next property read threw during render. The titlebar is
 *  part of the SHELL, so a per-panel boundary would not have caught it — the
 *  boundary that matters is the one at the root, which is why this wraps `App`
 *  rather than each workspace.
 *
 *  It is not browser-specific. The same throw from the same line blanks the
 *  desktop app; the browser client only made it reachable, because over HTTP
 *  the contract is JSON and nothing checks it, while on the desktop the preload
 *  and the renderer share one set of types and a wrong shape is a build error.
 *
 *  **Styled inline, deliberately.** This is the one component that has to render
 *  when the rest of the app could not, so it depends on nothing: no stylesheet
 *  class that may not have loaded, no store, no bridge, no context. A recovery
 *  screen that can itself fail to appear is not a recovery screen.
 */
interface ErrorBoundaryState {
  error: Error | null;
  info: string | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Kept in state rather than only logged: the console is where this used to
    // go and nobody reading a blank page thinks to open it.
    this.setState({ error, info: info.componentStack ?? null });
    // Still logged, because a stack in devtools is more useful than a summary
    // when you are the one fixing it.
    console.error("Metis renderer crashed:", error, info.componentStack);
  }

  render(): React.ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const browser = typeof window !== "undefined" && window.__METIS_CLIENT__ === "browser";
    return (
      <div
        role="alert"
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "32px",
          background: "#0d0f14",
          color: "#e6e8ee",
          font: "14px/1.6 system-ui, -apple-system, Segoe UI, sans-serif"
        }}
      >
        <div style={{ maxWidth: "620px", width: "100%" }}>
          <h1 style={{ margin: "0 0 8px", fontSize: "20px", fontWeight: 600 }}>Metis hit an error and stopped drawing.</h1>
          <p style={{ margin: "0 0 20px", color: "#9aa3b2" }}>
            {browser
              ? "This is the browser client. A reply from the gateway was not the shape the interface expected, which is the most likely cause — the desktop app is unaffected."
              : "Your work is not lost: conversations, snapshots and loops are on disk, not in this window."}
          </p>
          <pre
            style={{
              margin: "0 0 20px",
              padding: "12px 14px",
              borderRadius: "8px",
              background: "#161a22",
              border: "1px solid #262c38",
              color: "#ffb2b2",
              fontSize: "12.5px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word"
            }}
          >
            {error.message || String(error)}
          </pre>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: "8px 16px",
                borderRadius: "8px",
                border: "1px solid #2f6df6",
                background: "#2f6df6",
                color: "#fff",
                fontSize: "13px",
                cursor: "pointer"
              }}
            >
              Reload
            </button>
            {info ? (
              <details style={{ color: "#9aa3b2", fontSize: "12px" }}>
                <summary style={{ cursor: "pointer" }}>Where it happened</summary>
                <pre style={{ marginTop: "8px", whiteSpace: "pre-wrap", fontSize: "11.5px", maxHeight: "220px", overflow: "auto" }}>
                  {info}
                </pre>
              </details>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
}
