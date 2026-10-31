import { z } from 'zod';

import { hexColorSchema } from '../domain/color.js';
import { extensionCommandResultSchema } from '../domain/extension-command-result.js';
import { identifierSchema } from '../domain/identifiers.js';
import { treeItemActionSchema } from '../domain/tree-item.js';
import {
    extensionCommandIdSchema,
    MAX_EXTENSION_COMMAND_ARGUMENTS,
    viewIdSchema,
} from '../domain/views.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

const MOBILE_PANELS_MAX_CONTAINERS = 64;
const MOBILE_PANELS_MAX_VIEWS = 32;
const MOBILE_TREE_MAX_ITEMS = 500;

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

const mobilePanelsListParametersSchema = z.strictObject({ sessionId: identifierSchema });

/**
 * How a phone renders a secondary-sidebar view: `files` browses the Project with `mobile.files.*`, `changes` is the Git
 * source-control view served by `mobile.changes.*`, `tree` reads `mobile.tree.children`, and `unsupported` is a
 * Desktop-only view the phone lists but cannot show.
 */
const mobilePanelViewKindSchema = z.enum(['files', 'changes', 'tree', 'unsupported']);

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

const mobilePanelsListResultSchema = z.strictObject({
    panels: z.array(mobilePanelContainerSchema).max(MOBILE_PANELS_MAX_CONTAINERS),
});

const mobileTreeChildrenParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    viewId: viewIdSchema,
    parentHandle: z.string().min(1).max(512).optional(),
});

/**
 * A row's inline action as the phone draws it: the Desktop action with its icon bounded like every mobile icon. Server
 * Core projects only the actions a phone can run (see `canPhoneRunTreeAction`), so a Desktop-only command such as
 * `caxri.showLogs` never reaches a button the phone cannot honor.
 */
const mobileTreeItemActionSchema = treeItemActionSchema
    .omit({ icon: true })
    .extend({ icon: mobilePanelIconSchema.optional() });

/**
 * Projects `treeItemSchema` down to what a mobile row renders: label, description, a bounded icon, collapsible state,
 * and the inline actions the phone can run, such as the Status panel's per-repository `Merge`. `tooltip` and the row's
 * own `command` stay absent: a phone has no hover, and a tap on the row expands it.
 */
const mobileTreeItemSchema = z.strictObject({
    handle: z.string().min(1).max(512),
    label: z.string().min(1).max(1_024),
    description: z.string().max(1_024).optional(),
    icon: mobilePanelIconSchema.optional(),
    collapsibleState: z.enum(['none', 'collapsed', 'expanded']),
    actions: z.array(mobileTreeItemActionSchema).max(3).optional(),
});

const mobileTreeChildrenResultSchema = z.strictObject({
    items: z.array(mobileTreeItemSchema).max(MOBILE_TREE_MAX_ITEMS),
    reset: z.literal(true).optional(),
});

/**
 * Runs an extension command a tree row's inline action carries, for the Session the phone shows. The Extension Host
 * decides what the command does, exactly as for Desktop's `viewContainers.executeCommand`; the phone only resolves
 * `caxri.openExternal` itself.
 */
const mobileTreeExecuteCommandParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    commandId: extensionCommandIdSchema,
    arguments: z.array(z.unknown()).max(MAX_EXTENSION_COMMAND_ARGUMENTS).default([]),
});

/**
 * Session-scoped secondary-sidebar views from a paired device: the view list, Tree rows, and their inline actions.
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
    /**
     * An inline action can merge a pull request or change GitHub state that Caxri cannot undo, so it carries the
     * control grant `mobile.pullRequest.merge` does.
     */
    'mobile.tree.executeCommand': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: mobileTreeExecuteCommandParametersSchema,
        result: extensionCommandResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type MobileTreeItemAction = z.infer<typeof mobileTreeItemActionSchema>;
export type MobilePanelViewKind = z.infer<typeof mobilePanelViewKindSchema>;
