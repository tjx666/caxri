import { z } from 'zod';

import { hexColorSchema } from '../domain/color.js';
import { identifierSchema } from '../domain/domain.js';
import { viewIdSchema } from '../domain/views.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

export const MOBILE_PANELS_MAX_CONTAINERS = 64;
export const MOBILE_PANELS_MAX_VIEWS = 32;
export const MOBILE_TREE_MAX_ITEMS = 500;

/**
 * Bounded stand-in for the full {@link import('../domain/views.js').viewIconSchema}: a `resource` (data URL) icon is
 * dropped rather than projected, since every core-contributed secondary-sidebar container uses a `builtin` or `theme`
 * icon today and an extension-supplied image is not yet part of the mobile read surface.
 */
const mobilePanelIconSchema = z.strictObject({
    kind: z.enum(['builtin', 'theme']),
    id: z.string().min(1).max(100),
    /**
     * The same externally owned glyph tint as `viewIconSchema`'s theme `color`, such as a Linear workflow state.
     */
    color: hexColorSchema.optional(),
});

export const mobilePanelsListParametersSchema = z.strictObject({ sessionId: identifierSchema });

/**
 * How a phone renders a secondary-sidebar view: `files` browses the Project with `mobile.files.*`, `changes` is the Git
 * source-control view served by `mobile.changes.*`, `tree` reads `mobile.tree.children`, and `unsupported` is a
 * Desktop-only view the phone lists but cannot show.
 */
export const mobilePanelViewKindSchema = z.enum(['files', 'changes', 'tree', 'unsupported']);

const mobilePanelViewSchema = z.strictObject({
    id: viewIdSchema,
    title: z.string().min(1).max(200),
    kind: mobilePanelViewKindSchema,
    /**
     * Whether the view has a live badge provider. The mobile read surface does not fetch the current badge value, which
     * requires a separate per-view Extension Host round trip; this only tells the reader one exists.
     */
    hasBadge: z.boolean().optional(),
});

const mobilePanelContainerSchema = z.strictObject({
    id: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    icon: mobilePanelIconSchema.optional(),
    views: z.array(mobilePanelViewSchema).max(MOBILE_PANELS_MAX_VIEWS),
});

export const mobilePanelsListResultSchema = z.strictObject({
    panels: z.array(mobilePanelContainerSchema).max(MOBILE_PANELS_MAX_CONTAINERS),
});

export const mobileTreeChildrenParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    viewId: viewIdSchema,
    parentHandle: z.string().min(1).max(512).optional(),
});

/**
 * Projects `treeItemSchema` down to what a read-only mobile row renders: label, description, a bounded icon, and
 * collapsible state. `tooltip` and `command` are deliberately absent: mobile Conversation Tree is read-only and never
 * executes a command from a tree row.
 */
const mobileTreeItemSchema = z.strictObject({
    handle: z.string().min(1).max(512),
    label: z.string().min(1).max(1_024),
    description: z.string().max(1_024).optional(),
    icon: mobilePanelIconSchema.optional(),
    collapsibleState: z.enum(['none', 'collapsed', 'expanded']),
});

export const mobileTreeChildrenResultSchema = z.strictObject({
    items: z.array(mobileTreeItemSchema).max(MOBILE_TREE_MAX_ITEMS),
    reset: z.literal(true).optional(),
});

/**
 * Session-scoped secondary-sidebar views from a paired device: the view list and read-only Tree rows.
 */
export const mobilePanelsMethods = {
    'mobile.panels.list': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: mobilePanelsListParametersSchema,
        result: mobilePanelsListResultSchema,
    },
    'mobile.tree.children': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: mobileTreeChildrenParametersSchema,
        result: mobileTreeChildrenResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type MobilePanelViewKind = z.infer<typeof mobilePanelViewKindSchema>;
export type MobilePanelsListResult = z.infer<typeof mobilePanelsListResultSchema>;
export type MobileTreeChildrenResult = z.infer<typeof mobileTreeChildrenResultSchema>;
