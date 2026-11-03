import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'

interface ErrorBoundaryProps {
  /** Short name of the guarded panel, used in the fallback message. */
  label: string
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/** Keeps a crash in one panel (e.g. the WebGL twin) from blanking the whole cockpit, E-stop included. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`ROCO: ${this.props.label} crashed`, error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div
        role="alert"
        className="w-full h-full min-h-[12.5rem] rounded-xl border border-crit-line/80 bg-crit-soft/60 p-4 flex flex-col items-center justify-center gap-3 text-crit-ink text-sm text-center"
      >
        <AlertCircle className="w-6 h-6 text-crit" aria-hidden="true" />
        <p>
          {this.props.label} failed to start: {this.state.error.message}
        </p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="px-3 py-2 rounded-lg bg-crit-ink text-crit-soft font-semibold hover:bg-crit-ink/85 transition-colors"
        >
          Try again
        </button>
      </div>
    )
  }
}
