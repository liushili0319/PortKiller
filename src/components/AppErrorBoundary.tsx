import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { failed: boolean };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("PortKiller UI failed to render.", error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="fatal-screen">
          <p className="eyebrow">UI recovery boundary</p>
          <h1>界面加载失败</h1>
          <p>端点操作尚未执行。重新加载界面后可再次扫描。</p>
          <button className="button primary" type="button" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}
