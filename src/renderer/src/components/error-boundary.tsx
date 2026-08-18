import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';

import { Button } from './ui/button';

interface ErrorBoundaryProperties {
    children: ReactNode;
    /**
     * Message shown when this Renderer entry fails during React rendering.
     */
    description?: string;
    /**
     * Prefix used by Main's mirrored console log to identify the failed Renderer entry.
     */
    logScope?: string;
    /**
     * Label for the full-window reload action.
     */
    reloadLabel?: string;
    /**
     * Heading shown when this Renderer entry fails during React rendering.
     */
    title?: string;
}

interface ErrorBoundaryState {
    componentStack?: string;
    error?: unknown;
    hasError: boolean;
}

/**
 * Serializes the caught value for on-screen display and clipboard copy. The component stack is appended because React's
 * error `stack` often ends inside framework internals while the component stack names the failing feature tree.
 */
function describeThrown(value: unknown): string {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    try {
        return JSON.stringify(value);
    } catch {
        return Object.prototype.toString.call(value);
    }
}

function formatErrorDetails(error: unknown, componentStack?: string): string {
    const base = error instanceof Error && error.stack ? error.stack : describeThrown(error);
    return componentStack ? `${base}\n\nComponent stack:${componentStack}` : base;
}

/**
 * Top-level render-exception guard. React unmounts the whole tree on an uncaught error thrown during render, which
 * blanks the window with no in-app recovery path — Main's `render-process-gone` handler only covers process crashes,
 * not JS exceptions inside a live renderer. A full reload is safe to offer as the recovery action: durable workbench
 * state lives in the Runtime, while Process Explorer is a read-only diagnostic projection.
 *
 * The fallback renders the error message plus its stack and component stack so a crash is diagnosable directly from the
 * window. Error values stay inside the Renderer (only `console.error` mirrors them into local logs) — they may contain
 * source or workspace data and must never travel through diagnostics IPC.
 *
 * React 18/19 has no hook equivalent for `componentDidCatch`, so this stays a class component rather than pulling in
 * the `react-error-boundary` dependency for one boundary.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProperties, ErrorBoundaryState> {
    static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
        return { error, hasError: true };
    }

    private handleReload = (): void => {
        location.reload();
    };

    private handleCopy = (): void => {
        // Fire-and-forget: clipboard denial has no in-app recovery and the details stay on screen.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void navigator.clipboard.writeText(
            formatErrorDetails(this.state.error, this.state.componentStack),
        );
    };

    state: ErrorBoundaryState = { hasError: false };

    componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
        // Main mirrors renderer `console.error` calls into `logs/main.jsonl` (see
        // `window.webContents.on('console-message', ...)` in `src/main/index.ts`), so this is
        // enough to make a blank-window crash triageable without a dedicated IPC error channel.
        console.error(
            `${this.props.logScope ?? 'Renderer'} render error`,
            error,
            errorInfo.componentStack,
        );
        this.setState({ componentStack: errorInfo.componentStack ?? undefined });
    }

    render(): ReactNode {
        if (!this.state.hasError) return this.props.children;
        const { componentStack, error } = this.state;
        const message = error === undefined ? '' : describeThrown(error);
        return (
            <main className="renderer-crash-screen flex h-screen w-screen flex-col items-center justify-center gap-3 bg-background px-6 text-foreground">
                <div className="flex w-full max-w-2xl min-w-0 flex-col gap-3">
                    <h1 className="m-0 text-[15px] font-semibold">
                        {this.props.title ?? 'Something went wrong'}
                    </h1>
                    <p className="m-0 text-[13px] text-muted">
                        {this.props.description ??
                            'Caxri ran into an unexpected error. Reloading will bring back your projects and sessions.'}
                    </p>
                    {message && (
                        <p className="renderer-crash-message m-0 font-mono text-[13px] break-words text-danger">
                            {message}
                        </p>
                    )}
                    {error !== undefined && (
                        <pre className="renderer-crash-stack m-0 max-h-[360px] overflow-auto rounded border border-border bg-surface p-3 text-left font-mono text-[11px] leading-[1.5] whitespace-pre-wrap text-muted">
                            {formatErrorDetails(error, componentStack)}
                        </pre>
                    )}
                    <div className="flex gap-2">
                        <Button type="button" onClick={this.handleReload}>
                            {this.props.reloadLabel ?? 'Reload'}
                        </Button>
                        {error !== undefined && (
                            <Button type="button" variant="secondary" onClick={this.handleCopy}>
                                Copy details
                            </Button>
                        )}
                    </div>
                </div>
            </main>
        );
    }
}
