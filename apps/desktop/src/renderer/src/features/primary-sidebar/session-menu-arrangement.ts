import type { SessionMenuItemId, SessionMenuLayout } from '@caxri/protocol';
import { SESSION_MENU_SEPARATOR } from '@caxri/protocol';

import type { ContextMenuEntries } from '../../lib/context-menu';
import { CONTEXT_MENU_SEPARATOR } from '../../lib/context-menu';

/**
 * One menu entry per slot; a falsy slot is an action that does not apply to this Session.
 */
export type SessionMenuSlots = Record<SessionMenuItemId, ContextMenuEntries[number]>;

/**
 * Lays the Session menu's slots out in `layout` order, skipping hidden ones. `serializeContextMenu` then drops the
 * separators a hidden or inapplicable slot leaves at an edge or doubled up.
 */
export function arrangeSessionMenu(
    slots: SessionMenuSlots,
    layout: SessionMenuLayout,
): ContextMenuEntries {
    const hidden = new Set(layout.hidden);
    return layout.order.map((entry) => {
        if (entry === SESSION_MENU_SEPARATOR) return CONTEXT_MENU_SEPARATOR;
        return hidden.has(entry) ? false : slots[entry];
    });
}
