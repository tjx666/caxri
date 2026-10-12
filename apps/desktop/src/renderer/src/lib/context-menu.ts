import type { ContextMenuItemSpec } from '@caxri/protocol';

import { translate } from '../i18n';
import { tryCommand } from '../stores/toasts';
import { caxri } from './caxri';

interface ContextMenuAvailability {
    disabled?: boolean;
    /**
     * Why a disabled entry cannot run, in a short sentence. A native menu has no tooltip, so Main shows it with the
     * entry itself (see `buildContextMenuTemplate`); it is dropped while the entry is enabled.
     */
    disabledReason?: string;
}

/**
 * One entry of a native right-click menu. Menus are plain data built at the moment the menu opens, so a builder reads
 * live state directly instead of subscribing to it for a menu that is not showing.
 */
export type ContextMenuEntry =
    | { type: 'separator' }
    | ({
          type?: 'item';
          label: string;
          onSelect: () => unknown;
          /**
           * A keybinding `key` string shown right-aligned as the entry's shortcut hint; it never registers the key.
           */
          shortcut?: string;
      } & ContextMenuAvailability)
    | ({ type: 'submenu'; label: string; entries: ContextMenuEntries } & ContextMenuAvailability);

/**
 * Falsy slots let a builder write conditional entries inline (`isDirectory && {...}`).
 */
export type ContextMenuEntries = ReadonlyArray<ContextMenuEntry | false | null | undefined>;

export const CONTEXT_MENU_SEPARATOR = { type: 'separator' } as const satisfies ContextMenuEntry;

export interface SerializedContextMenu {
    items: ContextMenuItemSpec[];
    actions: Map<number, () => unknown>;
}

function availability({
    disabled,
    disabledReason,
}: ContextMenuAvailability): Pick<ContextMenuItemSpec, 'disabledReason' | 'enabled'> {
    if (!disabled) return {};
    return disabledReason ? { enabled: false, disabledReason } : { enabled: false };
}

/**
 * Drops falsy slots and any separator that would render at an edge or next to another separator, then assigns every
 * selectable entry an id. The callbacks stay in the Renderer; only the ids cross to Main.
 */
export function serializeContextMenu(entries: ContextMenuEntries): SerializedContextMenu {
    const actions = new Map<number, () => unknown>();
    const serialize = (level: ContextMenuEntries): ContextMenuItemSpec[] => {
        const items: ContextMenuItemSpec[] = [];
        for (const entry of level) {
            if (!entry) continue;
            if (entry.type === 'separator') {
                if (items.length > 0 && items.at(-1)?.type !== 'separator')
                    items.push({ type: 'separator' });
                continue;
            }
            if (entry.type === 'submenu') {
                const submenu = serialize(entry.entries);
                if (submenu.length === 0) continue;
                items.push({
                    type: 'submenu',
                    label: entry.label,
                    submenu,
                    ...availability(entry),
                });
                continue;
            }
            const id = actions.size;
            actions.set(id, entry.onSelect);
            items.push({
                type: 'item',
                id,
                label: entry.label,
                ...availability(entry),
                ...(entry.shortcut && { shortcut: entry.shortcut }),
            });
        }
        if (items.at(-1)?.type === 'separator') items.pop();
        return items;
    };
    return { items: serialize(entries), actions };
}

/**
 * Shows a native menu at a Renderer CSS-pixel position and runs the chosen entry's action after the menu has closed;
 * `onClose` runs in between, so a caller's "menu open" state is already cleared when the action starts. Resolves once
 * the action has finished, or once the menu is gone when nothing was chosen.
 */
export async function showContextMenu(
    entries: ContextMenuEntries,
    position?: { x: number; y: number },
    onClose?: () => void,
): Promise<void> {
    const { items, actions } = serializeContextMenu(entries);
    if (items.length === 0) return;
    const result = await tryCommand(translate('core.contextMenu.showFailed'), () =>
        caxri.request('contextMenu.show', {
            items,
            ...(position && {
                position: { x: Math.max(0, position.x), y: Math.max(0, position.y) },
            }),
        }),
    );
    onClose?.();
    if (result?.selectedId === undefined) return;
    await actions.get(result.selectedId)?.();
}
