import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';

import { useTranslation } from '../../i18n';
import { EditorLoadFailure } from './editor-load-failure';
import { editorRenderFailureReason } from './editor-load-state';

interface EditorErrorBoundaryProperties {
    children: ReactNode;
    /**
     * The tab the pane is showing. Another tab clears the failure: it has content of its own, and the failed tab stays
     * failed only for as long as it is the one on screen.
     */
    resetKey: string;
}

/**
 * The boundary's fallback, split out because a class component cannot read the translation hook.
 */
function EditorRenderFailure({ error, onReload }: { error: unknown; onReload: () => void }) {
    const { t } = useTranslation();
    return (
        <EditorLoadFailure
            actionLabel={t('editor.load.reloadWindow')}
            reason={t(editorRenderFailureReason(error))}
            onAction={onReload}
        />
    );
}

interface EditorErrorBoundaryState {
    error?: unknown;
    hasError: boolean;
    resetKey: string;
}

/**
 * Pane-local render guard for the editor area. The diff, transcript, preview, and Settings surfaces are `React.lazy`
 * chunks behind a bare `Suspense`, which covers only the pending state: a rejected import (a stale or missing build
 * asset) or an exception thrown while one rendered reached the window-level `ErrorBoundary` in `main.tsx` and replaced
 * the whole window (the side bar, every Terminal, every other pane) with the crash screen (issue #1012). Caught here,
 * the failure stays inside the pane that showed the tab, in the same shape as the file editor's own load failure.
 *
 * Reloading the window is the only recovery offered. `React.lazy` keeps a rejected import for the lifetime of the page,
 * so rendering the same tab again would rethrow the same failure; the reload requests the asset again, and nothing is
 * lost because durable workbench state lives in the Server. The error text never leaves the Renderer: the
 * `console.error` below is mirrored into local logs as a bounded classification, as `error-boundary.tsx` explains.
 *
 * A class component because React has no hook form of `componentDidCatch`.
 */
export class EditorErrorBoundary extends Component<
    EditorErrorBoundaryProperties,
    EditorErrorBoundaryState
> {
    static getDerivedStateFromError(error: unknown): Partial<EditorErrorBoundaryState> {
        return { error, hasError: true };
    }

    static getDerivedStateFromProps(
        properties: EditorErrorBoundaryProperties,
        state: EditorErrorBoundaryState,
    ): Partial<EditorErrorBoundaryState> | null {
        return properties.resetKey === state.resetKey
            ? null
            : { error: undefined, hasError: false, resetKey: properties.resetKey };
    }

    private handleReload = (): void => {
        location.reload();
    };

    state: EditorErrorBoundaryState = { hasError: false, resetKey: this.props.resetKey };

    componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
        console.error('Editor render error', error, errorInfo.componentStack);
    }

    render(): ReactNode {
        if (!this.state.hasError) return this.props.children;
        return <EditorRenderFailure error={this.state.error} onReload={this.handleReload} />;
    }
}
