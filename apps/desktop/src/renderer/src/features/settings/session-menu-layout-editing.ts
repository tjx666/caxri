import type { SessionMenuItemId, SessionMenuLayout } from '@caxri/protocol';
import {
    defaultSessionMenuLayout,
    normalizeSessionMenuLayout,
    SESSION_MENU_SEPARATOR,
} from '@caxri/protocol';
import { isEqual } from 'es-toolkit';

/**
 * The value `primarySidebar.sessionMenu` should store for an edited layout: `null` once it matches the built-in layout
 * again, so a newer Caxri's default order keeps applying instead of a frozen copy of today's.
 */
export function toStoredSessionMenuLayout(layout: SessionMenuLayout): SessionMenuLayout | null {
    const normalized = normalizeSessionMenuLayout(layout);
    return isEqual(normalized, defaultSessionMenuLayout) ? null : normalized;
}

/**
 * Moves the entry at `from` so it lands before the entry currently at `to`; `to === order.length` moves it to the end.
 * This is the index a drag insertion line points at, so a drop just below the dragged row is a no-op.
 */
export function moveSessionMenuEntry(
    layout: SessionMenuLayout,
    from: number,
    to: number,
): SessionMenuLayout {
    if (to === from || to === from + 1 || from < 0 || from >= layout.order.length) return layout;
    const order = [...layout.order];
    order.splice(to > from ? to - 1 : to, 0, ...order.splice(from, 1));
    return normalizeSessionMenuLayout({ ...layout, order });
}

/**
 * The `Option+Up` / `Option+Down` keyboard equivalent of a drag: one row up or down, clamped at the ends.
 */
export function moveSessionMenuEntryBy(
    layout: SessionMenuLayout,
    index: number,
    delta: -1 | 1,
): SessionMenuLayout {
    if (delta === -1) return index > 0 ? moveSessionMenuEntry(layout, index, index - 1) : layout;
    return index < layout.order.length - 1
        ? moveSessionMenuEntry(layout, index, index + 2)
        : layout;
}

export function toggleSessionMenuItemHidden(
    layout: SessionMenuLayout,
    id: SessionMenuItemId,
): SessionMenuLayout {
    const hidden = layout.hidden.includes(id)
        ? layout.hidden.filter((item) => item !== id)
        : [...layout.hidden, id];
    return normalizeSessionMenuLayout({ ...layout, hidden });
}

/**
 * A separator can go below a row only where it would render: not after the last entry and not next to another one.
 */
export function canInsertSessionMenuSeparator(layout: SessionMenuLayout, index: number): boolean {
    return (
        index + 1 < layout.order.length &&
        layout.order[index] !== SESSION_MENU_SEPARATOR &&
        layout.order[index + 1] !== SESSION_MENU_SEPARATOR
    );
}

export function insertSessionMenuSeparator(
    layout: SessionMenuLayout,
    index: number,
): SessionMenuLayout {
    if (!canInsertSessionMenuSeparator(layout, index)) return layout;
    const order = [...layout.order];
    order.splice(index + 1, 0, SESSION_MENU_SEPARATOR);
    return normalizeSessionMenuLayout({ ...layout, order });
}

export function removeSessionMenuSeparator(
    layout: SessionMenuLayout,
    index: number,
): SessionMenuLayout {
    if (layout.order[index] !== SESSION_MENU_SEPARATOR) return layout;
    return normalizeSessionMenuLayout({
        ...layout,
        order: layout.order.filter((_, position) => position !== index),
    });
}
