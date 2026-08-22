import { z } from 'zod';

export const MAX_VIEW_TREE_ITEMS = 1_000;
export const MAX_VIEW_TREE_PAYLOAD_BYTES = 256 * 1024;
export const MAX_VIEW_TREE_DEPTH = 64;
export const MAX_VIEW_TREE_HANDLES = 10_000;
export const MAX_VIEW_TREE_PERSISTED_IDS = 1_000;
export const MAX_EXTENSION_TREE_VIEW_STATES = 64;
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
const contributedViewContainerIdSchema = createNamespacedIdentifierSchema(
    MAX_NAMESPACED_IDENTIFIER_LENGTH - SHOW_VIEW_CONTAINER_COMMAND_PREFIX.length,
);
export const viewIdSchema = createNamespacedIdentifierSchema();
export const extensionIdSchema = z
    .string()
    .min(3)
    .max(200)
    .regex(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/);
export const extensionCommandIdSchema = createNamespacedIdentifierSchema();
export const extensionBuiltinIconIdSchema = z.enum(['beaker', 'status']);

export const viewContainerLocationSchema = z.enum(['secondarySidebar', 'panel']);
export const extensionCapabilitySchema = z.enum(['projects.read', 'sessions.read']);

export const viewIconSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('builtin'), id: z.string().min(1).max(100) }),
    z.object({ kind: z.literal('theme'), id: z.string().min(1).max(100) }),
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
    z.object({ kind: z.literal('extension'), extensionId: extensionIdSchema }),
]);

export const viewKindSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('builtin-react'),
        component: z.enum(['files', 'git', 'logs', 'info']),
    }),
    z.object({ kind: z.literal('tree') }),
]);

export const viewContainerDescriptorSchema = z.object({
    id: viewContainerIdSchema,
    location: viewContainerLocationSchema,
    source: descriptorSourceSchema,
    title: z.string().min(1).max(200),
    icon: viewIconSchema,
    commandId: extensionCommandIdSchema,
    lifecycle: z.union([z.literal('builtin'), extensionLifecycleStateSchema]),
    error: extensionErrorSchema.optional(),
});

export const viewDescriptorSchema = z.object({
    id: viewIdSchema,
    containerId: viewContainerIdSchema,
    source: descriptorSourceSchema,
    title: z.string().min(1).max(200),
    viewKind: viewKindSchema,
});

export const contributedCommandDescriptorSchema = z.object({
    id: extensionCommandIdSchema,
    title: z.string().min(1).max(200),
    description: z.string().max(1_024).optional(),
    source: descriptorSourceSchema,
    lifecycle: z.union([z.literal('builtin'), extensionLifecycleStateSchema]),
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

export const treeItemSchema = z.object({
    handle: z.string().min(1).max(512),
    id: treeItemIdSchema.optional(),
    label: z.string().min(1).max(1_024),
    description: z.string().max(1_024).optional(),
    tooltip: z.string().max(4_096).optional(),
    accessibilityLabel: z.string().min(1).max(1_024),
    collapsibleState: z.enum(['none', 'collapsed', 'expanded']),
    icon: viewIconSchema.optional(),
    command: treeItemCommandSchema.optional(),
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

const manifestIconResourcePathSchema = z
    .string()
    .min(1)
    .max(1_024)
    .regex(/^(?:\.\/)?(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\]+\.(?:png|svg)$/i);

const manifestContainerIconSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('builtin'), id: extensionBuiltinIconIdSchema }),
    z.object({ kind: z.literal('resource'), path: manifestIconResourcePathSchema }),
]);

const manifestContainerSchema = z.object({
    id: contributedViewContainerIdSchema,
    title: z.string().min(1).max(200),
    icon: manifestContainerIconSchema,
});

const manifestViewSchema = z.object({
    id: viewIdSchema,
    name: z.string().min(1).max(200),
    type: z.literal('tree'),
    when: z.never().optional(),
});

const manifestCommandSchema = z.object({
    command: extensionCommandIdSchema,
    title: z.string().min(1).max(200),
    description: z.string().max(1_024).optional(),
});

const manifestViewContainersSchema = z.object({
    secondarySidebar: z.array(manifestContainerSchema).max(64).default([]),
    panel: z.array(manifestContainerSchema).max(64).default([]),
});

const manifestViewsSchema = z.record(viewContainerIdSchema, z.array(manifestViewSchema).max(64));

const manifestContributionsSchema = z.object({
    viewsContainers: manifestViewContainersSchema.default({ secondarySidebar: [], panel: [] }),
    views: manifestViewsSchema.default({}),
    commands: z.array(manifestCommandSchema).max(256).default([]),
});

export const extensionManifestSchema = z.object({
    name: extensionIdSchema,
    version: z.string().min(1).max(100),
    type: z.literal('module'),
    main: z
        .string()
        .min(1)
        .max(1_024)
        .regex(/^(?:\.\/)?(?!.*(?:^|\/)\.\.(?:\/|$)).+\.(?:js|mjs)$/),
    engines: z.object({ caxri: z.string().min(1).max(100) }),
    caxri: z.object({
        capabilities: z.array(extensionCapabilitySchema).max(32).default([]),
        testOnly: z.boolean().optional(),
    }),
    activationEvents: z.never().optional(),
    contributes: manifestContributionsSchema.default({
        viewsContainers: { secondarySidebar: [], panel: [] },
        views: {},
        commands: [],
    }),
});

export type ViewContainerId = z.infer<typeof viewContainerIdSchema>;
export type ViewId = z.infer<typeof viewIdSchema>;
export type ViewContainerLocation = z.infer<typeof viewContainerLocationSchema>;
export type ExtensionCapability = z.infer<typeof extensionCapabilitySchema>;
export type ExtensionBuiltinIconId = z.infer<typeof extensionBuiltinIconIdSchema>;
export type ExtensionError = z.infer<typeof extensionErrorSchema>;
export type ExtensionLifecycleState = z.infer<typeof extensionLifecycleStateSchema>;
export type ViewIcon = z.infer<typeof viewIconSchema>;
export type ViewContainerDescriptor = z.infer<typeof viewContainerDescriptorSchema>;
export type ViewDescriptor = z.infer<typeof viewDescriptorSchema>;
export type ContributedCommandDescriptor = z.infer<typeof contributedCommandDescriptorSchema>;
export type ExtensionDescriptor = z.infer<typeof extensionDescriptorSchema>;
export type ViewCatalogSnapshot = z.infer<typeof viewCatalogSnapshotSchema>;
export type TreeItemDto = z.infer<typeof treeItemSchema>;
export type ExtensionTreeViewState = z.infer<typeof extensionTreeViewStateSchema>;
export type ExtensionTreeViewStates = z.infer<typeof extensionTreeViewStatesSchema>;
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;
