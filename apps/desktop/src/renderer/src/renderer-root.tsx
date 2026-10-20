import type { ComponentProps, ReactNode } from 'react';

import { QueryClientProvider } from '@tanstack/react-query';

import { ErrorBoundary } from './components/error-boundary';
import { I18nProvider } from './i18n';
import { queryClient } from './queries/client';
import { RootProviderFaultProbe } from './root-provider-fault-probe';

interface RendererRootProperties {
    /**
     * Recovery-screen copy for this window; the Workbench keeps the boundary's generic copy.
     */
    boundary?: Omit<ComponentProps<typeof ErrorBoundary>, 'children'>;
    children: ReactNode;
    /**
     * Whether the window reads server state through React Query. Process Explorer is a read-only projection and has no
     * query client.
     */
    withQuery?: boolean;
}

/**
 * The one root composition every Renderer entry mounts. The crash boundary is outermost so that a provider that throws
 * while rendering (the locale provider on a language switch, the query provider on first render) still lands on the
 * recovery screen instead of unmounting the window. The boundary's fallback depends on neither provider: it resolves
 * copy with `translate()`, which reads the locale store directly, and renders plain primitives.
 */
export function RendererRoot({ boundary, children, withQuery = true }: RendererRootProperties) {
    const content = withQuery ? (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ) : (
        children
    );
    return (
        <ErrorBoundary {...boundary}>
            <RootProviderFaultProbe>
                <I18nProvider>{content}</I18nProvider>
            </RootProviderFaultProbe>
        </ErrorBoundary>
    );
}
