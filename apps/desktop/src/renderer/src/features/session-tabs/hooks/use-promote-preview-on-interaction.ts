import type { RefObject } from 'react';
import { useEffect } from 'react';

import { keepActiveSessionTab } from '../session-tab-commands';
import { isKeepingInteraction } from '../session-tabs-state';

const KEEPING_EVENTS = ['keydown', 'pointerdown', 'paste', 'input'] as const;

/**
 * Keeps the active Session's tab when the user works in the Session: typing, pasting, or pressing anywhere inside
 * `containerRef` (a Terminal, a Chat composer, an Editor, a pane tab). Listens in the capture phase on the container
 * itself, so a child that stops propagation cannot hide the interaction and no per-Session component subscribes to
 * anything. The check is a store read, so an ordinary keystroke costs nothing once the tab is kept.
 */
export function usePromotePreviewOnInteraction(
    containerReference: RefObject<HTMLElement | null>,
): void {
    useEffect(() => {
        const container = containerReference.current;
        if (!container) return;
        const onInteraction = (event: Event): void => {
            if (
                isKeepingInteraction({
                    type: event.type,
                    ...(event instanceof KeyboardEvent && {
                        key: event.key,
                        metaKey: event.metaKey,
                        ctrlKey: event.ctrlKey,
                    }),
                    ...(event instanceof PointerEvent && { button: event.button }),
                })
            )
                keepActiveSessionTab();
        };
        for (const type of KEEPING_EVENTS)
            container.addEventListener(type, onInteraction, { capture: true });
        return () => {
            for (const type of KEEPING_EVENTS)
                container.removeEventListener(type, onInteraction, true);
        };
    }, [containerReference]);
}
