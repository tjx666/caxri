import { useCallback, useEffect, useRef } from 'react';

import { activePane } from '@shared/pane-layout';
import type { PaneLayout } from '@shared/types';

import { workTabId } from '../tabs/work-tab-accessibility';

/**
 * Hands keyboard focus back to a real tab after a layout change destroys the one that had it.
 *
 * Three edits take the focused element away, and none of them leaves focus anywhere useful: closing the focused tab,
 * dragging it into another pane, and closing a pane's only tab. `WorkTab` marks a leaving tab `inert` for its exit
 * animation — which blurs whatever was focused inside it — and a collapsing pane unmounts its bar outright. Either way
 * the browser falls back to `document.body`, from which no arrow key, `Tab`, or tablist-scoped shortcut works any
 * more.
 *
 * Owned once for the whole layout rather than per tab bar. A bar can only see its own tabs and only knows whether _it_
 * is active, so the two edits that move focus across panes are invisible to the bar that lost the tab: by the time it
 * hears the blur, `activePaneId` already points somewhere else, and in the collapse case the bar is gone before it can
 * hear anything. Resolving the target from the fresh layout instead covers all three from one place.
 */
export function useTabFocusRecovery(layout: PaneLayout | undefined): void {
    const wasPaneFocused = useRef(false);
    const layoutReference = useRef(layout);
    const recover = useCallback((): void => {
        /**
         * Deferred a frame because the `inert` blur lands _after_ React commits: reading `document.activeElement`
         * synchronously would still see the leaving tab focused and conclude nothing was lost.
         */
        requestAnimationFrame(() => {
            // Recovering only from `document.body` — the browser's "nothing is focused" state — keeps this to repairing
            // a loss rather than competing for focus with anything that legitimately took it in the meantime.
            const current = layoutReference.current;
            if (!current || !wasPaneFocused.current || document.activeElement !== document.body)
                return;
            const pane = activePane(current);
            const tab =
                pane.tabs.find((candidate) => candidate.id === pane.activeTabId) ?? pane.tabs.at(0);
            if (!tab) return;
            /**
             * Scoped to the active pane's own bar: a tab dragged across panes exists twice for the length of the exit
             * animation — the arriving copy plus the leaving `inert` ghost in the old bar — and a document-order lookup
             * by id would find the ghost, where `focus()` silently does nothing.
             */
            const button = document
                .querySelector(`[data-pane-tab-bar="${CSS.escape(pane.id)}"]`)
                ?.querySelector<HTMLElement>(`:scope #${CSS.escape(workTabId(tab.id))}`);
            if (!button) return;
            // The same marker `navigate` sets, for the same reason: activating a Terminal otherwise hands focus to
            // xterm, which would undo the WAI-ARIA tab focus this is restoring. `WorkTab` clears it on blur.
            if (tab.resource.kind === 'terminal') button.dataset.preserveTerminalFocus = 'true';
            button.focus();
        });
    }, []);
    useEffect(() => {
        /**
         * `focusin` fires only when something _gains_ focus, so focus falling back to `document.body` leaves this flag
         * standing — which is precisely the state worth repairing. Focus somewhere outside the panes entirely (the
         * sidebar, a Settings field) clears it, so a layout edit the user made from elsewhere never yanks focus back.
         *
         * The whole pane counts, not just its tab bar: a Terminal hands focus to xterm's helper textarea the moment its
         * pane activates, so a tab-bar-only flag would read "the user left" for the most ordinary state there is, and
         * switch the recovery off for the tab that Terminal is sitting in.
         */
        const onFocusIn = (event: FocusEvent): void => {
            if (!(event.target instanceof Element)) return;
            /**
             * A menu renders in a portal and holds focus for as long as it is open, so it always looks like the user
             * left the panes. Treating that as leaving would switch the recovery off in exactly the case that needs it
             * most: the menu's own Close or Split destroys the element the menu would hand focus back to, so focus
             * lands on `document.body` and nothing is left to notice.
             */
            if (event.target.closest('[role="menu"], [role="menuitem"], [role="dialog"]')) return;
            wasPaneFocused.current = Boolean(event.target.closest('[data-pane-id]'));
        };
        /**
         * The primary trigger. The `inert` blur that ends a tab's exit animation fires _after_ the layout commit that
         * caused it, so a recovery driven by the layout alone would run a frame too early and see the leaving tab still
         * focused.
         */
        const onFocusOut = (event: FocusEvent): void => {
            // Focus moving somewhere real is the user's own doing; only focus going nowhere is a loss to repair.
            if (event.relatedTarget || !wasPaneFocused.current) return;
            recover();
        };
        addEventListener('focusin', onFocusIn);
        addEventListener('focusout', onFocusOut);
        return () => {
            removeEventListener('focusin', onFocusIn);
            removeEventListener('focusout', onFocusOut);
        };
    }, [recover]);
    useEffect(() => {
        layoutReference.current = layout;
        /**
         * The second trigger, for the edits that never produce a blur at all: a pane collapsing takes its whole bar out
         * of the tree, and an element removed from the document loses focus to `body` without notifying anyone.
         */
        recover();
    }, [layout, recover]);
}
