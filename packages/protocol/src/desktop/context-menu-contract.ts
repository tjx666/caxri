import { z } from 'zod';

import { commandPolicy } from '../transport/method-spec.js';

const desktopControl = commandPolicy('desktop', 'control');

/**
 * Bounds one native menu so a runaway builder cannot hand Main an unbounded template; the largest shipped menu (the
 * Files row) has fewer than twenty entries.
 */
const MAX_CONTEXT_MENU_ITEMS = 64;
const MAX_CONTEXT_MENU_DEPTH = 3;

export interface ContextMenuItemSpec {
    type: 'item' | 'separator' | 'submenu';
    /**
     * Renderer-assigned identity echoed back when the user picks the entry. Separators and submenu parents never carry
     * one because they cannot be chosen.
     */
    id?: number;
    label?: string;
    enabled?: boolean;
    /**
     * A keybinding `key` string (`cmd+shift+c`, `cmd+k cmd+s`) shown as a hint only. Main renders a single chord as a
     * native accelerator that is never registered, and appends a chord sequence to the label because an accelerator
     * cannot express one.
     */
    shortcut?: string;
    submenu?: ContextMenuItemSpec[];
}

function contextMenuItemSchema(depth: number): z.ZodType<ContextMenuItemSpec> {
    const base = z.strictObject({
        id: z.number().int().nonnegative().optional(),
        label: z.string().min(1).max(512).optional(),
        enabled: z.boolean().optional(),
        shortcut: z.string().min(1).max(128).optional(),
    });
    const leaf = z.discriminatedUnion('type', [
        base.extend({
            type: z.literal('item'),
            id: z.number().int().nonnegative(),
            label: z.string().min(1).max(512),
        }),
        base.extend({ type: z.literal('separator') }),
    ]);
    if (depth >= MAX_CONTEXT_MENU_DEPTH) return leaf;
    const children = z
        .array(contextMenuItemSchema(depth + 1))
        .min(1)
        .max(MAX_CONTEXT_MENU_ITEMS);
    const submenu = base.extend({
        type: z.literal('submenu'),
        label: z.string().min(1).max(512),
        submenu: children,
    });
    return z.union([leaf, submenu]);
}

export const contextMenuItemsSchema = z
    .array(contextMenuItemSchema(1))
    .min(1)
    .max(MAX_CONTEXT_MENU_ITEMS);

/**
 * Right-click menus render as native OS menus owned by Main. The Renderer sends plain data and receives only the chosen
 * entry's id, so no callback, DOM node, or command string crosses the IPC boundary: the Renderer keeps every action and
 * looks it up by id after the menu closes.
 */
export const contextMenuDesktopMethods = {
    'contextMenu.show': {
        ...desktopControl,
        params: z.object({
            items: contextMenuItemsSchema,
            /**
             * Anchor in the Renderer's CSS pixels. Main converts it through the window's zoom factor, which the
             * Renderer cannot read, so a zoomed window still opens the menu under the pointer.
             */
            position: z
                .object({ x: z.number().nonnegative(), y: z.number().nonnegative() })
                .optional(),
        }),
        /**
         * `selectedId` is absent when the menu closed without a choice (Escape, outside click, or focus loss).
         */
        result: z.object({ selectedId: z.number().int().nonnegative().optional() }),
    },
} as const;
