import type { ReactNode } from 'react';
import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { usePaneViewLayoutSignal } from './pane-view-layout-signal';

/**
 * The split tree owns geometry; this stable portal owns the pane's React lifetime and events. Moving its existing host
 * preserves xterm instead of detaching and replaying the same PTY. Keeping the whole PaneBox inside the portal also
 * preserves its focus and drag event ancestry.
 */
export function PaneMountPortal({ children, paneId }: { children: ReactNode; paneId: string }) {
    const [container] = useState(() => {
        const element = document.createElement('div');
        element.className = 'h-full w-full min-h-0 min-w-0';
        return element;
    });
    const layoutSignal = usePaneViewLayoutSignal();
    useLayoutEffect(() => {
        /**
         * Document-wide on purpose, and safe even though the Workbench now mounts one `PaneView` per kept-alive Session
         * (issue #657): pane ids are UUIDs (`pane-layout-reducer.ts:21`) and therefore unique across Sessions, not just
         * within one.
         *
         * `layoutSignal` re-runs this after a split or merge recreates this pane's slot marker under a new DOM node —
         * which can happen without `paneId` itself changing — instead of after every unrelated `PaneView` render (issue
         * #815; see `pane-view-layout-signal.ts` for why the signal has to come from a context value rather than a ref
         * a parent effect would populate too late).
         */
        const slot = document.querySelector(`[data-pane-slot="${CSS.escape(paneId)}"]`);
        if (slot && container.parentElement !== slot) slot.append(container);
    }, [container, layoutSignal, paneId]);
    useLayoutEffect(() => () => container.remove(), [container]);
    return createPortal(children, container);
}
