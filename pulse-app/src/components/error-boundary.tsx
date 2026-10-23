import { Component, type ReactNode } from "react";

// A page that breaks shows this instead of a blank screen: what happened and
// the way back. resetKey (the page's address): moving to another page tries
// again. The error goes to the browser console for whoever is fixing it.
type Props = { children: ReactNode; resetKey?: string };
type State = { failed: boolean; key?: string };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }

  componentDidCatch(error: unknown) {
    console.error("Pulse: this page stopped with an error", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="screen">
        <div className="card pad" role="alert" style={{ display: "grid", gap: 10, maxWidth: 520, margin: "40px auto" }}>
          <b style={{ fontSize: 16 }}>Something went wrong on this page.</b>
          <span style={{ color: "var(--muted)" }}>
            Nothing you saved is lost. Reload the page to try again, or go back to Home.
          </span>
          <span style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
            <a className="btn" href="/home">Go to Home</a>
          </span>
        </div>
      </section>
    );
  }
}
