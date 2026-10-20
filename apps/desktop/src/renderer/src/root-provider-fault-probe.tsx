import type { ReactNode } from 'react';

import { shouldFailRootProvider } from './root-provider-fault';

const faultMemo: { fault?: boolean } = {};

/**
 * Stands in for a provider that fails while rendering; renders its children untouched otherwise.
 */
export function RootProviderFaultProbe({ children }: { children: ReactNode }) {
    if (shouldFailRootProvider(sessionStorage, faultMemo)) {
        throw new Error('Forced root provider render error');
    }
    return children;
}
