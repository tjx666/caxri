import type { ReactNode } from 'react';
import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

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
    useLayoutEffect(() => {
        /**
         * Document-wide on purpose: the parent ref is not attached until after child layout effects on first mount, but
         * the slot is already in the committed DOM. Safe even though the Workbench now mounts one `PaneView` per
         * kept-alive Session (issue #657), because pane ids are UUIDs (`pane-layout-reducer.ts:21`) and therefore
         * unique across Sessions, not just within one.
         */
        const slot = document.querySelector(`[data-pane-slot="${CSS.escape(paneId)}"]`);
        if (slot && container.parentElement !== slot) slot.append(container);
    });
    useLayoutEffect(() => () => container.remove(), [container]);
    return createPortal(children, container);
}
