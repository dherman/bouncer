import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 40,
            color: '#d9534f',
            backgroundColor: '#1a1a1a',
            fontFamily: 'monospace',
            height: '100vh',
            overflow: 'auto',
          }}
        >
          <h2>Renderer Error</h2>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {this.state.error.message}
          </pre>
          <pre
            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#888', fontSize: 12 }}
          >
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 20, padding: '8px 16px', cursor: 'pointer' }}
          >
            Try to recover
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
