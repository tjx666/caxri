import type { MouseEvent } from 'react';
import { useRef } from 'react';

import { translate } from '../i18n';
import { awaitThenCleanup } from '../lib/await-then-cleanup';
import type { ContextMenuEntries } from '../lib/context-menu';
import { showContextMenu } from '../lib/context-menu';
import { tryCommand } from '../stores/toasts';
import { useLatestReference } from './use-latest-reference';

export interface ContextMenuOptions {
    /**
     * Reports the native menu's open state, e.g. to keep the row highlighted while its menu is showing. `false` arrives
     * after the menu closed and before the chosen action runs.
     */
    onOpenChange?: (isOpen: boolean) => void;
}

/**
 * Returns an `onContextMenu` handler that opens a native menu at the gesture. `build` runs when the menu opens, not on
 * render, so it reads the latest state and may await data the menu needs (a lazily fetched status, for example).
 *
 * The handler claims the event: `preventDefault` so Chromium shows nothing of its own and `stopPropagation` so an
 * enclosing surface's menu (the Files tree background behind a row) does not open as well. A second gesture while a
 * menu is still being built or shown is ignored; the native menu is modal anyway.
 */
export function useContextMenu(
    build: () => ContextMenuEntries | Promise<ContextMenuEntries>,
    options: ContextMenuOptions = {},
): (event: MouseEvent) => void {
    const latest = useLatestReference({ build, onOpenChange: options.onOpenChange });
    const isOpen = useRef(false);
    return (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (isOpen.current) return;
        isOpen.current = true;
        const position = { x: event.clientX, y: event.clientY };
        latest.current.onOpenChange?.(true);
        const close = (): void => {
            if (!isOpen.current) return;
            isOpen.current = false;
            latest.current.onOpenChange?.(false);
        };
        void awaitThenCleanup(
            (async () => {
                const entries = await tryCommand(translate('core.contextMenu.showFailed'), () =>
                    Promise.resolve(latest.current.build()),
                );
                if (entries) await showContextMenu(entries, position, close);
            })(),
            close,
        );
    };
}
