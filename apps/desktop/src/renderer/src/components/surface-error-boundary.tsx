import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';

import { TriangleAlert } from 'lucide-react';

import { useTranslation } from '../i18n';
import type { SurfaceFaultMemo, SurfaceScope } from './surface-fault';
import { releaseSurfaceFault, shouldFailSurface } from './surface-fault';
import { Button } from './ui/button';
import { Empty, EmptyMedia, EmptyTitle } from './ui/empty';

/**
 * What a custom fallback receives: the caught value and the action that renders the surface again.
 */
interface SurfaceFallbackContext {
    error: unknown;
    reset: () => void;
}

interface SurfaceErrorBoundaryProperties {
    children: ReactNode;
    /**
     * Replaces the default message and Retry button, for a surface whose recovery is not a plain re-render.
     */
    fallback?: (context: SurfaceFallbackContext) => ReactNode;
    /**
     * Shape of the default fallback: `block` fills the surface, `inline` is one compact row inside a list.
     */
    layout?: 'block' | 'inline';
    /**
     * Identity of what the surface shows. A new value clears a caught failure, so a failed tab stays failed only while
     * it is the one on screen.
     */
    resetKey: string;
    scope: SurfaceScope;
}

interface SurfaceErrorBoundaryState {
    error?: unknown;
    hasError: boolean;
    resetKey: string;
}

const faultMemo: SurfaceFaultMemo = {};

/**
 * Throws while the E2E fault seam is armed for this surface (`surface-fault.ts`); renders its children otherwise.
 */
function SurfaceFaultProbe({
    children,
    instanceKey,
    scope,
}: {
    children: ReactNode;
    instanceKey: string;
    scope: SurfaceScope;
}) {
    if (shouldFailSurface(sessionStorage, faultMemo, scope, instanceKey)) {
        throw new Error('Forced surface render error');
    }
    return children;
}

/**
 * Default fallback, a function component because a class component cannot read the translation hook. The message is
 * fixed product copy: the caught error text stays out of the UI, as it may carry transcript, Terminal, or source data.
 */
function SurfaceRenderFailure({
    layout,
    reset,
}: {
    layout: 'block' | 'inline';
    reset: () => void;
}) {
    const { t } = useTranslation();
    if (layout === 'inline') {
        return (
            <div
                role="alert"
                className="flex items-center gap-2 rounded border border-border bg-surface px-3 py-2 text-xs text-muted"
            >
                <TriangleAlert aria-hidden="true" className="shrink-0 text-danger" size={14} />
                <span className="min-w-0 flex-1">{t('core.surfaceBoundary.inlineMessage')}</span>
                <Button size="sm" variant="secondary" onClick={reset}>
                    {t('common.retry')}
                </Button>
            </div>
        );
    }
    return (
        <Empty className="empty-work h-full flex-1" role="alert">
            <EmptyMedia>
                <TriangleAlert aria-hidden="true" className="text-danger" size={28} />
            </EmptyMedia>
            <EmptyTitle className="max-w-80 text-pretty">
                {t('core.surfaceBoundary.message')}
            </EmptyTitle>
            <Button size="sm" variant="secondary" onClick={reset}>
                {t('common.retry')}
            </Button>
        </Empty>
    );
}

/**
 * Surface-local render guard. React unmounts the whole tree on an uncaught render error, so without a boundary around a
 * surface a single bad Chat entry, Terminal pane, Settings page, or view replaced the entire window with the crash
 * screen (issue #3176). Caught here, the failure stays inside the surface and the rest of the Workbench keeps working;
 * the window-level `ErrorBoundary` remains the last resort for what no surface boundary covers.
 *
 * The caught error is logged with `console.error`, which Main mirrors into local logs as a bounded classification
 * (error class, source, size, stable identity), never as its text, exactly as `error-boundary.tsx` explains. The
 * fallback shows fixed copy only, so transcript, Terminal, and source content never reach the UI or the logs.
 *
 * A class component because React has no hook form of `componentDidCatch`.
 */
export class SurfaceErrorBoundary extends Component<
    SurfaceErrorBoundaryProperties,
    SurfaceErrorBoundaryState
> {
    static getDerivedStateFromError(error: unknown): Partial<SurfaceErrorBoundaryState> {
        return { error, hasError: true };
    }

    static getDerivedStateFromProps(
        properties: SurfaceErrorBoundaryProperties,
        state: SurfaceErrorBoundaryState,
    ): Partial<SurfaceErrorBoundaryState> | null {
        return properties.resetKey === state.resetKey
            ? null
            : { error: undefined, hasError: false, resetKey: properties.resetKey };
    }

    private handleReset = (): void => {
        releaseSurfaceFault(faultMemo, this.props.scope, this.props.resetKey);
        this.setState({ error: undefined, hasError: false });
    };

    state: SurfaceErrorBoundaryState = { hasError: false, resetKey: this.props.resetKey };

    componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
        console.error(`${this.props.scope} render error`, error, errorInfo.componentStack);
    }

    render(): ReactNode {
        const { children, fallback, layout = 'block', resetKey, scope } = this.props;
        if (this.state.hasError) {
            return fallback ? (
                fallback({ error: this.state.error, reset: this.handleReset })
            ) : (
                <SurfaceRenderFailure layout={layout} reset={this.handleReset} />
            );
        }
        return (
            <SurfaceFaultProbe instanceKey={resetKey} scope={scope}>
                {children}
            </SurfaceFaultProbe>
        );
    }
}
