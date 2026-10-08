import { createContext, use } from 'react';

import { useSessionById } from '../../stores/selectors';

/**
 * Which Session the surrounding `PaneView` belongs to.
 *
 * The Workbench mounts one `PaneView` per kept-alive Session (issue #657), so "the selected Session" stopped being a
 * safe stand-in for "this pane's Session" anywhere inside the pane tree. Anything under a `PaneView` that needs the
 * Session (its layout, its Terminals) reads it from here instead of from the selection.
 *
 * `undefined` outside a `PaneView`, where following the selection is still correct.
 */
const PaneViewSessionContext = createContext<string | undefined>(undefined);

export const PaneViewSessionProvider = PaneViewSessionContext.Provider;

export function usePaneViewSessionId(): string | undefined {
    return use(PaneViewSessionContext);
}

export function usePaneViewSession() {
    return useSessionById(usePaneViewSessionId());
}
