import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';

import { Check, X } from 'lucide-react';

import type { CopyFeedbackStatus } from './copy-feedback';
import {
    COPY_FEEDBACK_RESET_MS,
    copyButtonLabel,
    writeToClipboardWithFeedback,
} from './copy-feedback';
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
    /**
     * Feedback state for the "Copy details" button; the crash fallback has no toast host, so the button acknowledges
     * the clipboard result itself (see `copy-feedback.ts`).
     */
    copyStatus: CopyFeedbackStatus;
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
 * blanks the window with no in-app recovery path; Main's `render-process-gone` handler only covers process crashes, not
 * JS exceptions inside a live renderer. A full reload is safe to offer as the recovery action: durable workbench state
 * lives in the Server, while Process Explorer is a read-only diagnostic projection.
 *
 * The fallback shows the error message and keeps its stack and component stack in a collapsed disclosure so a crash is
 * diagnosable without covering the recovery actions. The error value itself never leaves the Renderer: it may contain
 * source or workspace data, which diagnostics must exclude, so the `console.error` below is mirrored into local logs as
 * a bounded classification rather than as its text.
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

    /**
     * Pending timer that reverts the button label back to idle; re-clicking before it fires clears and restarts it so
     * rapid re-clicks never leave a stale "Copied"/"Copy failed" label stuck on screen.
     */
    private copyResetTimeout: ReturnType<typeof setTimeout> | undefined;

    private handleCopy = (): void => {
        if (this.copyResetTimeout !== undefined) clearTimeout(this.copyResetTimeout);
        const text = formatErrorDetails(this.state.error, this.state.componentStack);
        // eslint-disable-next-line no-void -- resolved via the .then below, never rejects
        void writeToClipboardWithFeedback(navigator.clipboard, text).then((status) => {
            this.setState({ copyStatus: status });
            this.copyResetTimeout = setTimeout(() => {
                this.setState({ copyStatus: 'idle' });
            }, COPY_FEEDBACK_RESET_MS);
        });
    };

    state: ErrorBoundaryState = { copyStatus: 'idle', hasError: false };

    componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
        // Desktop mirrors renderer `console.error` calls into `logs/desktop.jsonl` (see
        // `window.webContents.on('console-message', ...)` in `apps/desktop/src/main/index.ts`). The text is not
        // recorded: `console-error-fields.ts` reduces it to error class, source, size, and a stable identity, which is
        // what makes a blank-window crash triageable without a dedicated IPC error channel. The full text stays here,
        // on screen and behind the Copy action, for the user to hand over deliberately.
        console.error(
            `${this.props.logScope ?? 'Renderer'} render error`,
            error,
            errorInfo.componentStack,
        );
        this.setState({ componentStack: errorInfo.componentStack ?? undefined });
    }

    componentWillUnmount(): void {
        if (this.copyResetTimeout !== undefined) clearTimeout(this.copyResetTimeout);
    }

    render(): ReactNode {
        if (!this.state.hasError) return this.props.children;
        const { componentStack, copyStatus, error } = this.state;
        const message = error === undefined ? '' : describeThrown(error);
        const copyLabel = copyButtonLabel(copyStatus, 'Copy details');
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
                        <details className="min-w-0 text-[12px] text-muted">
                            <summary className="w-fit cursor-pointer rounded outline-none hover:text-foreground focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]">
                                Technical details
                            </summary>
                            <pre className="renderer-crash-stack mt-2 max-h-[360px] overflow-auto rounded border border-border bg-surface p-3 text-left font-mono text-[11px] leading-[1.5] whitespace-pre-wrap text-muted">
                                {formatErrorDetails(error, componentStack)}
                            </pre>
                        </details>
                    )}
                    <div className="flex gap-2">
                        <Button type="button" onClick={this.handleReload}>
                            {this.props.reloadLabel ?? 'Reload'}
                        </Button>
                        {error !== undefined && (
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={this.handleCopy}
                                className={copyStatus === 'failed' ? 'text-danger' : undefined}
                            >
                                {copyStatus === 'copied' && <Check size={13} />}
                                {copyStatus === 'failed' && <X size={13} />}
                                {copyLabel}
                            </Button>
                        )}
                    </div>
                </div>
            </main>
        );
    }
}
