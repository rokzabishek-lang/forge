import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface State {
  error: Error | null
  stack: string | null
}

/**
 * Without this, any render-time throw unmounts the whole tree and the window
 * goes black with nothing to go on. A crash should name itself.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, stack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ stack: info.componentStack ?? null })
    console.error('Forge crashed while rendering:', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error, stack } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-ink-950 p-8 text-center">
        <AlertTriangle size={22} className="text-amber-500" />
        <div className="text-sm text-ink-200">Something in the interface crashed</div>
        <div className="max-w-lg font-mono text-[11px] leading-relaxed text-red-400">
          {error.message}
        </div>
        {stack && (
          <pre className="max-h-40 max-w-lg overflow-auto rounded bg-ink-900 p-2 text-left font-mono text-[10px] leading-snug text-ink-600">
            {stack.trim()}
          </pre>
        )}
        <button
          onClick={() => this.setState({ error: null, stack: null })}
          className="mt-1 rounded bg-ink-800 px-3 py-1.5 text-[11px] text-ink-200 hover:bg-ink-700"
        >
          Try again
        </button>
        <div className="text-[10.5px] text-ink-600">
          Your project is still loaded — this only reset the view.
        </div>
      </div>
    )
  }
}
