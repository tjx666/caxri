import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from './ui/button';

interface ErrorBoundaryProps {
    children: ReactNode;
}

interface ErrorBoundaryState {
    hasError: boolean;
}

/**
 * Top-level render-exception guard. React unmounts the whole tree on an uncaught error thrown
 * during render, which blanks the window with no in-app recovery path — Main's
 * `render-process-gone` handler only covers process crashes, not JS exceptions inside a live
 * renderer. A full reload is safe to offer as the recovery action: Session/Project state lives in
 * the Runtime (SQLite) rather than in-memory Renderer state, so a reload reattaches to the same
 * Sessions instead of losing work.
 *
 * React 18/19 has no hook equivalent for `componentDidCatch`, so this stays a class component
 * rather than pulling in the `react-error-boundary` dependency for one boundary.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { hasError: false };

    static getDerivedStateFromError(): ErrorBoundaryState {
        return { hasError: true };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
        // Main mirrors renderer `console.error` calls into `logs/main.jsonl` (see
        // `window.webContents.on('console-message', ...)` in `src/main/index.ts`), so this is
        // enough to make a blank-window crash triageable without a dedicated IPC error channel.
        console.error('Renderer render error', error, errorInfo.componentStack);
    }

    private handleReload = (): void => {
        window.location.reload();
    };

    render(): ReactNode {
        if (!this.state.hasError) return this.props.children;
        return (
            <main className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-background text-center text-foreground">
                <h1 className="m-0 text-[15px] font-semibold">Something went wrong</h1>
                <p className="m-0 max-w-sm text-[13px] text-muted">
                    Caxri ran into an unexpected error. Reloading will bring back your projects and
                    sessions.
                </p>
                <Button type="button" onClick={this.handleReload}>
                    Reload
                </Button>
            </main>
        );
    }
}
