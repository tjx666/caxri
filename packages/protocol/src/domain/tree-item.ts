import { z } from 'zod';

import { parseExternalHttpUrl } from '../configuration/trusted-domains.js';
import {
    extensionCommandIdSchema,
    MAX_EXTENSION_COMMAND_ARGUMENTS,
    MAX_TREE_ITEM_TOOLTIP_MARKDOWN,
    MAX_VIEW_TREE_ITEMS,
    treeItemIdSchema,
    viewIconSchema,
} from './views.js';

/**
 * Wire shapes for one extension TreeItem and a `getChildren` batch: the row's presentation, its hover card, its own
 * command, and its inline actions. Split from `./views.ts`, which owns the catalog, view state, and Source Control
 * shapes these rows live inside.
 */

export const treeItemCommandSchema = z.object({
    id: extensionCommandIdSchema,
    title: z.string().min(1).max(200),
    arguments: z.array(z.unknown()).max(MAX_EXTENSION_COMMAND_ARGUMENTS).optional(),
});

/**
 * Inline row actions are icon buttons that share the row's width with its label, so a provider gets a handful at most.
 */
export const MAX_TREE_ITEM_ACTIONS = 3;

export const treeItemActionSchema = z.object({
    command: treeItemCommandSchema,
    icon: viewIconSchema,
    /**
     * Visible text that keeps the action on screen at rest; see `TreeItemAction.label` in the Extension API.
     */
    label: z.string().min(1).max(32).optional(),
    /**
     * Color that also keeps the action on screen at rest, labeled or not; see `TreeItemAction.tone`.
     */
    tone: z.enum(['neutral', 'success', 'warning', 'danger']).optional(),
    /**
     * Rendered through the Workbench confirmation modal as literal text before the command is dispatched.
     */
    confirmation: z
        .object({
            title: z.string().min(1).max(200),
            message: z.string().min(1).max(1_024),
            confirmLabel: z.string().min(1).max(64),
        })
        .optional(),
});

export const treeItemVariantSchema = z.enum(['header', 'message']);
const treeItemTooltipUrlSchema = z
    .string()
    .min(1)
    .max(16_384)
    .refine((value) => parseExternalHttpUrl(value).ok, 'Expected a safe HTTP(S) URL');
const treeItemTooltipBadgeSchema = z.object({
    label: z.string().min(1).max(64),
    tone: z.enum(['neutral', 'success', 'warning', 'danger']),
});
const treeItemTooltipRowSchema = z.object({
    label: z.string().min(1).max(64),
    value: z.string().min(1).max(2_048),
    url: treeItemTooltipUrlSchema.optional(),
});
const treeItemTooltipRowsSchema = z
    .array(treeItemTooltipRowSchema)
    .max(8)
    .refine(
        (rows) =>
            new Set(rows.map((row) => `${row.label}\0${row.value}\0${row.url ?? ''}`)).size ===
            rows.length,
        'Rich tooltip rows must be unique',
    );
export const treeItemRichTooltipSchema = z
    .object({
        kind: z.literal('rich'),
        title: z.string().min(1).max(1_024),
        /**
         * Prose that explains the title, such as a provider error's recovery hint. Structured facts belong in `rows`.
         */
        description: z.string().min(1).max(1_024).optional(),
        /**
         * Authored Markdown prose rendered through `parseMarkdownBlocks`, never as HTML. Mutually exclusive with
         * `description`.
         */
        markdown: z.string().min(1).max(MAX_TREE_ITEM_TOOLTIP_MARKDOWN).optional(),
        badge: treeItemTooltipBadgeSchema.optional(),
        /**
         * Empty when the title (and badge) already carry the whole hover, so a row without structured facts still uses
         * the same card instead of falling back to the plain-text tooltip.
         */
        rows: treeItemTooltipRowsSchema.default([]),
    })
    .refine(
        (tooltip) => tooltip.description === undefined || tooltip.markdown === undefined,
        'A rich tooltip carries either description or markdown, not both',
    );

export const treeItemSchema = z
    .object({
        handle: z.string().min(1).max(512),
        id: treeItemIdSchema.optional(),
        variant: treeItemVariantSchema.optional(),
        label: z.string().min(1).max(1_024),
        description: z.string().max(1_024).optional(),
        tooltip: z.union([z.string().max(4_096), treeItemRichTooltipSchema]).optional(),
        accessibilityLabel: z.string().min(1).max(1_024),
        collapsibleState: z.enum(['none', 'collapsed', 'expanded']),
        icon: viewIconSchema.optional(),
        trailingIcon: viewIconSchema.optional(),
        command: treeItemCommandSchema.optional(),
        actions: z.array(treeItemActionSchema).max(MAX_TREE_ITEM_ACTIONS).optional(),
    })
    .superRefine((item, context) => {
        if (item.variant === 'message' && item.collapsibleState !== 'none')
            context.addIssue({
                code: 'custom',
                message: 'A message TreeItem must be a leaf',
                path: ['collapsibleState'],
            });
    });

export const treeChildrenResultSchema = z.object({
    items: z.array(treeItemSchema).max(MAX_VIEW_TREE_ITEMS),
    reset: z.literal(true).optional(),
});

export type TreeItemDto = z.infer<typeof treeItemSchema>;
export type TreeChildrenResult = z.infer<typeof treeChildrenResultSchema>;
