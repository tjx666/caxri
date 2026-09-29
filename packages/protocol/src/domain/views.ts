import { z } from 'zod';

import { parseExternalHttpUrl } from '../configuration/trusted-domains.js';
import { hexColorSchema } from './color.js';

export const MAX_VIEW_TREE_ITEMS = 1_000;
export const MAX_VIEW_TREE_PAYLOAD_BYTES = 256 * 1024;
export const MAX_VIEW_TREE_DEPTH = 64;
/**
 * Bounds one hover card's Markdown body; a longer review comment is truncated by the extension, not rejected.
 */
export const MAX_TREE_ITEM_TOOLTIP_MARKDOWN = 8_192;
export const MAX_VIEW_TREE_HANDLES = 10_000;
export const MAX_VIEW_TREE_PERSISTED_IDS = 1_000;
export const MAX_EXTENSION_TREE_VIEW_STATES = 64;
export const MAX_SOURCE_CONTROL_VIEW_STATES = 64;
export const MAX_SOURCE_CONTROL_VIEW_STATE_ENTRIES = 1_000;
export const MAX_EXTENSION_COMMAND_ARGUMENTS = 32;
export const MAX_VIEW_ICON_DATA_URL_LENGTH = 128 * 1024;
export const MAX_VIEW_CATALOG_CONTAINERS = 256;
export const MAX_VIEW_CATALOG_VIEWS = 1_024;
export const MAX_VIEW_CATALOG_COMMANDS = 1_024;
export const MAX_VIEW_CATALOG_EXTENSIONS = 256;
export const SHOW_VIEW_CONTAINER_COMMAND_PREFIX = 'viewContainers.show.';
const MAX_NAMESPACED_IDENTIFIER_LENGTH = 200;

function createNamespacedIdentifierSchema(maxLength = MAX_NAMESPACED_IDENTIFIER_LENGTH) {
    return z
        .string()
        .min(1)
        .max(maxLength)
        .regex(/^[A-Z0-9](?:[\w.-]*[A-Z0-9])?$/i);
}

export const viewContainerIdSchema = createNamespacedIdentifierSchema();
export const contributedViewContainerIdSchema = createNamespacedIdentifierSchema(
    MAX_NAMESPACED_IDENTIFIER_LENGTH - SHOW_VIEW_CONTAINER_COMMAND_PREFIX.length,
);
export const viewIdSchema = createNamespacedIdentifierSchema();
export const extensionIdSchema = z
    .string()
    .min(3)
    .max(200)
    .regex(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/);
export const extensionCommandIdSchema = createNamespacedIdentifierSchema();
export const extensionBuiltinIconIdSchema = z.enum(['beaker', 'files', 'git-branch', 'status']);

export const viewContainerLocationSchema = z.enum(['secondarySidebar', 'panel']);
/**
 * Every member must be reachable by an `assertApiAccess` call in the extension service. A declared capability that no
 * check consumes constrains nothing, so it reads as authority the extension does not actually hold. Session identity is
 * part of the base API context an extension receives from its lifecycle `scopeId`, not a separate readable surface, so
 * there is deliberately no `sessions.read`.
 */
export const extensionCapabilitySchema = z.enum([
    'git.read',
    'git.write',
    'projects.read',
    'settings.read',
]);

export const viewIconSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('builtin'), id: z.string().min(1).max(100) }),
    z.object({
        kind: z.literal('theme'),
        id: z.string().min(1).max(100),
        /**
         * Tint for an icon standing in for content owned by an external system whose palette Caxri does not define — a
         * Linear workflow state, whose color each workspace configures for itself. Caxri's own semantic tokens cannot
         * express an arbitrary workspace's palette, and quantizing it back to `success`/`warning` is what made a green
         * "In Review" render yellow. Deliberately the only color literal in the view protocol: it tints one glyph's
         * foreground and nothing else, and it is validated here so no unchecked string reaches a `style` attribute.
         * Absent means the icon inherits its row's theme color, which every Caxri-owned icon does.
         */
        color: hexColorSchema.optional(),
    }),
    z.object({
        kind: z.literal('resource'),
        dataUrl: z.string().startsWith('data:image/').max(MAX_VIEW_ICON_DATA_URL_LENGTH),
    }),
]);

export const extensionLifecycleStateSchema = z.enum([
    'discovered',
    'activating',
    'active',
    'error',
    'crashed',
    'disabled',
]);

/**
 * Scope attached to every extension-owned view event. A view event is never a global UI signal: it belongs to the
 * Session and Workbench Root that were current when the provider emitted it.
 */
export const extensionViewEventContextSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('session'),
        sessionId: z.string().min(1).max(200),
        workbenchProjectId: z.string().min(1).max(200),
    }),
    z.object({ kind: z.literal('no-session') }),
]);
export const extensionViewEventIdSchema = z.string().min(1).max(200);

export const extensionErrorSchema = z.object({
    code: z.enum([
        'MANIFEST_INVALID',
        'ENGINE_INCOMPATIBLE',
        'DUPLICATE_ID',
        'COMMONJS_ENTRY_UNSUPPORTED',
        'COMMONJS_API_UNSUPPORTED',
        'ELECTRON_IMPORT_DENIED',
        'API_IMPORT_UNOWNED',
        'ACTIVATION_FAILED',
        'PROVIDER_MISSING',
        'PROVIDER_FAILED',
        'PROVIDER_TIMEOUT',
        'PROVIDER_CAPACITY',
        'PAYLOAD_TOO_LARGE',
        'CAPABILITY_DENIED',
        'PROJECT_SCOPE_DENIED',
        'GENERATION_EXPIRED',
        'EXTENSION_HOST_UNAVAILABLE',
    ]),
    message: z.string().min(1).max(2_048),
});

const descriptorSourceSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('builtin') }),
    z.object({ kind: z.literal('core') }),
    z.object({ kind: z.literal('extension'), extensionId: extensionIdSchema }),
]);

export const viewKindSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('builtin-react'),
        component: z.enum(['logs', 'info']),
    }),
    z.object({ kind: z.literal('tree') }),
    z.object({ kind: z.literal('resource-explorer') }),
    z.object({ kind: z.literal('source-control') }),
]);

export const controlledViewPresentationSchema = z.object({
    noContextMessage: z.string().min(1).max(2_048),
    loadingMessage: z.string().min(1).max(2_048),
    actionErrorMessage: z.string().min(1).max(2_048),
    refreshErrorMessage: z.string().min(1).max(2_048),
});

/**
 * Project search is deliberately absent: it is a workbench-wide overlay reached by command, not a view-container
 * action, so there is no surface left that could render a `resource.search` button for a view to declare.
 */
export const extensionViewActionRoleSchema = z.enum([
    'resource.createFile',
    'resource.createFolder',
    'resource.collapse',
    'resource.refresh',
]);

export const viewActionDescriptorSchema = z.object({
    commandId: extensionCommandIdSchema,
    role: extensionViewActionRoleSchema,
});

export const viewContainerDescriptorSchema = z.object({
    id: viewContainerIdSchema,
    location: viewContainerLocationSchema,
    source: descriptorSourceSchema,
    title: z.string().min(1).max(200),
    icon: viewIconSchema,
    commandId: extensionCommandIdSchema,
    lifecycle: z.union([z.literal('builtin'), z.literal('core'), extensionLifecycleStateSchema]),
    error: extensionErrorSchema.optional(),
});

export const viewDescriptorSchema = z.object({
    id: viewIdSchema,
    containerId: viewContainerIdSchema,
    source: descriptorSourceSchema,
    title: z.string().min(1).max(200),
    viewKind: viewKindSchema,
    badge: z.literal(true).optional(),
    presentation: controlledViewPresentationSchema.optional(),
    configurationDependencies: z.array(z.string().min(1).max(200)).max(32).optional(),
    actions: z.array(viewActionDescriptorSchema).max(32).optional(),
});

export const contributedCommandDescriptorSchema = z.object({
    id: extensionCommandIdSchema,
    title: z.string().min(1).max(200),
    description: z.string().max(1_024).optional(),
    allowInEditable: z.boolean().optional(),
    palette: z.boolean().optional(),
    source: descriptorSourceSchema,
    lifecycle: z.union([z.literal('builtin'), z.literal('core'), extensionLifecycleStateSchema]),
});

export const extensionDescriptorSchema = z.object({
    id: extensionIdSchema,
    version: z.string().min(1).max(100),
    generation: z.number().int().nonnegative(),
    lifecycle: extensionLifecycleStateSchema,
    error: extensionErrorSchema.optional(),
});

export const viewCatalogSnapshotSchema = z.object({
    revision: z.number().int().nonnegative(),
    containers: z.array(viewContainerDescriptorSchema).max(MAX_VIEW_CATALOG_CONTAINERS),
    views: z.array(viewDescriptorSchema).max(MAX_VIEW_CATALOG_VIEWS),
    commands: z.array(contributedCommandDescriptorSchema).max(MAX_VIEW_CATALOG_COMMANDS),
    extensions: z.array(extensionDescriptorSchema).max(MAX_VIEW_CATALOG_EXTENSIONS),
});

export const treeItemCommandSchema = z.object({
    id: extensionCommandIdSchema,
    title: z.string().min(1).max(200),
    arguments: z.array(z.unknown()).max(MAX_EXTENSION_COMMAND_ARGUMENTS).optional(),
});

export const treeItemIdSchema = z.string().min(1).max(480);
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

export const extensionTreeViewStateSchema = z.object({
    expandedItemIds: z.array(treeItemIdSchema).max(MAX_VIEW_TREE_PERSISTED_IDS),
    initializedItemIds: z.array(treeItemIdSchema).max(MAX_VIEW_TREE_PERSISTED_IDS),
    focusedItemId: treeItemIdSchema.optional(),
});

export const extensionTreeViewStatesSchema = z
    .record(viewIdSchema, extensionTreeViewStateSchema)
    .refine(
        (states) => Object.keys(states).length <= MAX_EXTENSION_TREE_VIEW_STATES,
        'Too many persisted extension tree views',
    );

const sourceControlDisclosureStateSchema = (keySchema: z.ZodString) =>
    z
        .record(keySchema, z.boolean())
        .refine(
            (state) => Object.keys(state).length <= MAX_SOURCE_CONTROL_VIEW_STATE_ENTRIES,
            'Too many persisted Source Control disclosure entries',
        );

export const sourceControlViewStateSchema = z.object({
    expandedDirectories: sourceControlDisclosureStateSchema(z.string().min(1).max(16_384)),
    expandedGroups: sourceControlDisclosureStateSchema(treeItemIdSchema),
    expandedProviders: sourceControlDisclosureStateSchema(treeItemIdSchema),
    modeId: treeItemIdSchema.optional(),
});

export const sourceControlViewStatesSchema = z
    .record(viewIdSchema, sourceControlViewStateSchema)
    .refine(
        (states) => Object.keys(states).length <= MAX_SOURCE_CONTROL_VIEW_STATES,
        'Too many persisted Source Control views',
    );

export const extensionViewChangeSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('badge') }),
    z.object({ kind: z.literal('content') }),
    z.object({ kind: z.literal('refresh') }),
    z.object({
        kind: z.literal('selection'),
        selectedModeId: treeItemIdSchema,
    }),
]);

export const sourceControlViewIconSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('theme'), id: z.string().min(1).max(100) }),
    z.object({ kind: z.literal('file-type'), name: z.string().min(1).max(1_024) }),
]);

const sourceControlCommandArgumentsSchema = z
    .array(z.unknown())
    .max(MAX_EXTENSION_COMMAND_ARGUMENTS);
const sourceControlCommandBindingSchema = z.object({
    id: extensionCommandIdSchema,
    arguments: sourceControlCommandArgumentsSchema.optional(),
});

export const sourceControlActionSchema = z.object({
    id: treeItemIdSchema,
    label: z.string().min(1).max(1_024),
    icon: sourceControlViewIconSchema,
    command: sourceControlCommandBindingSchema,
    accessibilityLabel: z.string().min(1).max(1_024).optional(),
    tooltip: z.string().min(1).max(1_024).optional(),
    disabled: z.boolean().optional(),
    pressed: z.boolean().optional(),
    progressLabel: z.string().min(1).max(1_024).optional(),
    emphasis: z.literal('danger').optional(),
    errorMessage: z.string().min(1).max(1_024).optional(),
});

const sourceControlResourceDecorationSchema = z.object({
    identifier: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-z0-9-]+$/),
    label: z.string().min(1).max(32),
    tone: z.enum(['danger', 'success', 'warning']),
});

export const sourceControlResourceSchema = z.object({
    id: treeItemIdSchema,
    label: z.string().min(1).max(1_024),
    description: z.string().max(1_024).optional(),
    tooltip: z.string().min(1).max(4_096),
    accessibilityLabel: z.string().min(1).max(1_024),
    icon: sourceControlViewIconSchema,
    path: z.string().max(4_096),
    decoration: sourceControlResourceDecorationSchema.optional(),
    lineStats: z
        .object({
            additions: z.number().int().nonnegative(),
            deletions: z.number().int().nonnegative(),
        })
        .optional(),
    editorResource: z.string().min(1).max(8_192).optional(),
    action: sourceControlActionSchema.optional(),
    actions: z.array(sourceControlActionSchema).max(32).optional(),
});

const sourceControlGroupSchema = z.object({
    id: treeItemIdSchema,
    label: z.string().min(1).max(1_024),
    count: z.number().int().nonnegative().max(100_000),
    hiddenCount: z.number().int().nonnegative().max(100_000).optional(),
    expandedByDefault: z.boolean(),
    emptyMessage: z.string().min(1).max(2_048),
    isLoading: z.boolean().optional(),
    truncationMessage: z.string().min(1).max(2_048).optional(),
    actions: z.array(sourceControlActionSchema).max(32),
    resources: z.array(sourceControlResourceSchema).max(2_000),
});

export const sourceControlHistoryDescriptorSchema = z.object({
    id: treeItemIdSchema,
    label: z.string().min(1).max(1_024),
    command: sourceControlCommandBindingSchema,
    pathInputLabel: z.string().min(1).max(1_024),
    pathInputPlaceholder: z.string().min(1).max(1_024),
    clearPathLabel: z.string().min(1).max(1_024),
    loadingMessage: z.string().min(1).max(1_024),
    emptyMessage: z.string().min(1).max(1_024),
    loadMoreLabel: z.string().min(1).max(1_024),
    loadingMoreLabel: z.string().min(1).max(1_024),
    loadErrorMessage: z.string().min(1).max(1_024),
    detailsLoadingMessage: z.string().min(1).max(1_024),
    detailsErrorMessage: z.string().min(1).max(1_024),
    detailsLabel: z.string().min(1).max(1_024),
    detailsEmptyMessage: z.string().min(1).max(1_024),
    detailsTruncatedMessage: z.string().min(1).max(1_024),
    itemAccessibilityLabelPrefix: z.string().min(1).max(1_024),
    itemActivation: z.literal('action').optional(),
    pageSize: z.number().int().min(1).max(50),
    revision: z.string().max(1_024).optional(),
});

const sourceControlFileHistorySchema = z.object({
    label: z.string().min(1).max(1_024),
    description: z.string().min(1).max(1_024).optional(),
    tooltip: z.string().min(1).max(4_096).optional(),
    emptyMessage: z.string().min(1).max(2_048),
    path: z.string().min(1).max(4_096).optional(),
    history: sourceControlHistoryDescriptorSchema,
});

const sourceControlExternalLinkSchema = z.object({
    url: z.url().max(8_192),
    /**
     * Names the destination in the row's tooltip and accessible description, so the modifier gesture is discoverable
     * without a visible link glyph.
     */
    label: z.string().min(1).max(1_024),
});

const sourceControlProviderModelSchema = z.object({
    id: treeItemIdSchema,
    label: z.string().min(1).max(1_024),
    kindLabel: z.string().min(1).max(1_024).optional(),
    icon: sourceControlViewIconSchema,
    tooltip: z.string().min(1).max(4_096),
    /**
     * Absolute filesystem root of the repository this provider owns, used only to resolve a provider-relative resource
     * path back to an absolute one. `tooltip` is free display text and must never be read as a path. Omit it when the
     * provider has no filesystem root; consumers then disable path-dependent affordances such as drag-to-Terminal
     * instead of guessing.
     */
    rootPath: z.string().min(1).max(4_096).optional(),
    /**
     * What the repository has checked out — a branch, or a name for a detached commit — shown as the section's first
     * row and allowed to ellipsize. Empty hides that row, for when it would only repeat `label`. Prose that a provider
     * wants beside the row belongs in `descriptionTooltip`.
     */
    description: z.string().max(4_096),
    /**
     * Glyph of the description row: a branch, or a single commit for a detached HEAD.
     */
    descriptionKind: z.enum(['branch', 'commit']),
    /**
     * Short trailing status of the description row, such as unsynced commit counts (`↑2 ↓1`) or `detached`.
     */
    descriptionBadge: z.string().min(1).max(64).optional(),
    descriptionAccessibilityLabel: z.string().min(1).max(4_096),
    descriptionTooltip: z.string().min(1).max(4_096),
    /**
     * Trailing counts; empty when every count is zero, since a synced, clean repository shows no count noise.
     */
    countLabel: z.string().max(1_024),
    /**
     * Web page describing the changes this provider is currently showing — the pull request in Pull Request mode.
     * Alt-clicking the provider row or its group caption opens it in the default browser, so the panel never has to
     * spend row width on a link affordance that is empty in most modes.
     */
    externalLink: sourceControlExternalLinkSchema.optional(),
    /**
     * Uncommitted work the selected mode is not showing, plus the mode that does show it. This is deliberately not a
     * `sourceControlAction`: changing the panel's mode is the mode switch's job, and routing it through the action
     * registry instead would give the same state change two dispatch paths.
     */
    uncommittedNotice: z
        .object({
            modeId: treeItemIdSchema,
            accessibilityLabel: z.string().min(1).max(1_024),
            tooltip: z.string().min(1).max(1_024),
        })
        .optional(),
    expandedByDefault: z.boolean(),
    actions: z.array(sourceControlActionSchema).max(32),
    groups: z.array(sourceControlGroupSchema).max(64),
    history: sourceControlHistoryDescriptorSchema.optional(),
});

const sourceControlModeSchema = z.object({
    id: treeItemIdSchema,
    label: z.string().min(1).max(1_024),
    icon: sourceControlViewIconSchema,
    command: sourceControlCommandBindingSchema,
});

export const sourceControlViewModelSchema = z.object({
    revision: z.string().min(1).max(200),
    title: z.string().min(1).max(1_024),
    accessibilityLabel: z.string().min(1).max(1_024),
    modeAccessibilityLabel: z.string().min(1).max(1_024),
    modes: z.array(sourceControlModeSchema).max(32),
    selectedModeId: treeItemIdSchema,
    refreshAction: sourceControlActionSchema,
    headerActions: z.array(sourceControlActionSchema).max(32).optional(),
    fileHistory: sourceControlFileHistorySchema.optional(),
    providers: z.array(sourceControlProviderModelSchema).max(1_000),
    emptyMessage: z.string().min(1).max(2_048).optional(),
    emptyKind: z.enum(['no-repository', 'unavailable']).optional(),
    truncationMessage: z.string().min(1).max(2_048).optional(),
});

const sourceControlHistoryItemSchema = z.object({
    id: treeItemIdSchema,
    label: z.string().max(4_096),
    description: z.string().max(1_024),
    timestamp: z.number().int().nonnegative(),
    tooltipTimestamp: z.string().min(1).max(1_024),
    author: z.string().max(1_024),
    authorFallback: z.string().min(1).max(16),
    avatarUrl: z.url().max(8_192).optional(),
    decorations: z.array(z.string().max(1_024)).max(50),
    body: z.string().max(16_384).optional(),
    action: sourceControlActionSchema.optional(),
});

export const sourceControlHistoryPageSchema = z.object({
    revision: z.string().min(1).max(200),
    items: z.array(sourceControlHistoryItemSchema).max(50),
    nextOffset: z.number().int().nonnegative().optional(),
});

export const sourceControlHistoryDetailsSchema = z.object({
    revision: z.string().min(1).max(200),
    itemId: treeItemIdSchema,
    summary: z.string().min(1).max(1_024),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    resources: z.array(sourceControlResourceSchema).max(2_000),
    hiddenCount: z.number().int().nonnegative().max(2_000).optional(),
    truncated: z.boolean(),
});

const sourceControlActionEffectSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('open-editor'),
        resource: z.string().min(1).max(8_192),
    }),
    z.object({
        kind: z.literal('toast'),
        message: z.string().min(1).max(2_048),
        tone: z.literal('success'),
    }),
]);

export const sourceControlActionResultSchema = z.object({
    revision: z.string().min(1).max(200),
    effects: z.array(sourceControlActionEffectSchema).max(32),
    refresh: z.boolean(),
});

export type ViewContainerId = z.infer<typeof viewContainerIdSchema>;
export type ViewId = z.infer<typeof viewIdSchema>;
export type ViewContainerLocation = z.infer<typeof viewContainerLocationSchema>;
export type ExtensionCapability = z.infer<typeof extensionCapabilitySchema>;
export type ExtensionBuiltinIconId = z.infer<typeof extensionBuiltinIconIdSchema>;
export type ExtensionError = z.infer<typeof extensionErrorSchema>;
export type ExtensionLifecycleState = z.infer<typeof extensionLifecycleStateSchema>;
export type ExtensionViewEventContext = z.infer<typeof extensionViewEventContextSchema>;
export type ExtensionViewChange = z.infer<typeof extensionViewChangeSchema>;
export type SourceControlAction = z.infer<typeof sourceControlActionSchema>;
export type SourceControlActionEffect = z.infer<typeof sourceControlActionEffectSchema>;
export type SourceControlActionResult = z.infer<typeof sourceControlActionResultSchema>;
export type SourceControlExternalLink = z.infer<typeof sourceControlExternalLinkSchema>;
export type SourceControlHistoryDescriptor = z.infer<typeof sourceControlHistoryDescriptorSchema>;
export type SourceControlFileHistory = z.infer<typeof sourceControlFileHistorySchema>;
export type SourceControlHistoryDetails = z.infer<typeof sourceControlHistoryDetailsSchema>;
export type SourceControlHistoryPage = z.infer<typeof sourceControlHistoryPageSchema>;
export type SourceControlResource = z.infer<typeof sourceControlResourceSchema>;
export type SourceControlViewModel = z.infer<typeof sourceControlViewModelSchema>;
export type ExtensionViewActionRole = z.infer<typeof extensionViewActionRoleSchema>;
export type ViewActionDescriptor = z.infer<typeof viewActionDescriptorSchema>;
export type ViewIcon = z.infer<typeof viewIconSchema>;
export type ViewContainerDescriptor = z.infer<typeof viewContainerDescriptorSchema>;
export type ViewDescriptor = z.infer<typeof viewDescriptorSchema>;
export type ControlledViewPresentation = z.infer<typeof controlledViewPresentationSchema>;
export type ContributedCommandDescriptor = z.infer<typeof contributedCommandDescriptorSchema>;
export type ExtensionDescriptor = z.infer<typeof extensionDescriptorSchema>;
export type ViewCatalogSnapshot = z.infer<typeof viewCatalogSnapshotSchema>;
export type TreeItemDto = z.infer<typeof treeItemSchema>;
export type TreeChildrenResult = z.infer<typeof treeChildrenResultSchema>;
export type ExtensionTreeViewState = z.infer<typeof extensionTreeViewStateSchema>;
export type ExtensionTreeViewStates = z.infer<typeof extensionTreeViewStatesSchema>;
export type SourceControlViewState = z.infer<typeof sourceControlViewStateSchema>;
export type SourceControlViewStates = z.infer<typeof sourceControlViewStatesSchema>;
