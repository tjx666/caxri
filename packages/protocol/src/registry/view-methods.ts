/* eslint-disable unicorn/max-nested-calls -- Declarative Zod schemas intentionally compose bounded validators inline. */
import { z } from 'zod';

import { extensionCommandResultSchema } from '../domain/extension-command-result.js';
import { identifierSchema } from '../domain/identifiers.js';
import { treeChildrenResultSchema } from '../domain/tree-item.js';
import { viewBadgeSchema } from '../domain/view-badges.js';
import {
    extensionCommandIdSchema,
    extensionViewEventContextSchema,
    MAX_EXTENSION_COMMAND_ARGUMENTS,
    sourceControlActionResultSchema,
    sourceControlHistoryDetailsSchema,
    sourceControlHistoryPageSchema,
    sourceControlViewModelSchema,
    viewCatalogSnapshotSchema,
    viewIdSchema,
} from '../domain/views.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

const common = {
    viewId: viewIdSchema,
    requestId: identifierSchema,
    context: extensionViewEventContextSchema,
};

export const extensionViewOperationSchema = z.discriminatedUnion('operation', [
    z.object({
        ...common,
        operation: z.literal('badge.snapshot'),
        arguments: z.strictObject({}),
    }),
    z.object({
        ...common,
        operation: z.literal('source.snapshot'),
        arguments: z.object({
            activeResource: z.string().min(1).max(8_192).optional(),
            preferredModeId: z.string().min(1).max(480).optional(),
            refresh: z.number().int().nonnegative().default(0),
            revision: z.string().min(1).max(200).optional(),
        }),
    }),
    z.object({
        ...common,
        operation: z.literal('source.historyPage'),
        arguments: z.object({
            historyId: z.string().min(1).max(480),
            itemActivation: z.literal('action').optional(),
            offset: z.number().int().nonnegative().max(10_000).default(0),
            pageSize: z.number().int().min(1).max(50).default(25),
            path: z.string().max(4_096).optional(),
            revision: z.string().min(1).max(200),
        }),
    }),
    z.object({
        ...common,
        operation: z.literal('source.historyDetails'),
        arguments: z.object({
            historyId: z.string().min(1).max(480),
            itemId: z.string().min(1).max(480),
            path: z.string().max(4_096).optional(),
            revision: z.string().min(1).max(200),
        }),
    }),
    z.object({
        ...common,
        operation: z.literal('source.action'),
        arguments: z.object({
            actionId: z.string().min(1).max(480),
            revision: z.string().min(1).max(200),
        }),
    }),
]);

export type ExtensionViewOperationName = z.infer<typeof extensionViewOperationSchema>['operation'];

export interface ExtensionViewOperationMetadata {
    /**
     * Provider registration family used by the Extension Host.
     */
    provider: 'badge' | 'source';
    /**
     * Whether a host cancellation rejects a late provider result or leaves it authoritative.
     */
    cancellation: 'reject' | 'authoritative';
    /**
     * Whether the request may use the generic Extension Host timeout.
     */
    lifetime: 'expiring' | 'non-expiring';
}

/**
 * Every view operation's provider routing and lifetime semantics live here so a new operation cannot silently miss one
 * of the Host, Core, transport, or Renderer policy consumers.
 */
export const extensionViewOperationMetadata = {
    'badge.snapshot': {
        provider: 'badge',
        cancellation: 'reject',
        lifetime: 'expiring',
    },
    'source.snapshot': {
        provider: 'source',
        cancellation: 'reject',
        lifetime: 'expiring',
    },
    'source.historyPage': {
        provider: 'source',
        cancellation: 'reject',
        lifetime: 'expiring',
    },
    'source.historyDetails': {
        provider: 'source',
        cancellation: 'reject',
        lifetime: 'expiring',
    },
    'source.action': {
        provider: 'source',
        cancellation: 'authoritative',
        lifetime: 'non-expiring',
    },
} as const satisfies Record<ExtensionViewOperationName, ExtensionViewOperationMetadata>;

export const extensionViewOperationNames = Object.keys(extensionViewOperationMetadata) as [
    ExtensionViewOperationName,
    ...ExtensionViewOperationName[],
];
export const extensionViewOperationNameSchema = z.enum(extensionViewOperationNames);

export function isExtensionViewOperationName(value: string): value is ExtensionViewOperationName {
    return extensionViewOperationNames.includes(value as ExtensionViewOperationName);
}

export function isExtensionViewReadOperation(operation: ExtensionViewOperationName): boolean {
    return extensionViewOperationMetadata[operation].cancellation === 'reject';
}

export const extensionViewOperationResultSchemas = {
    'badge.snapshot': viewBadgeSchema.nullable(),
    'source.snapshot': sourceControlViewModelSchema,
    'source.historyPage': sourceControlHistoryPageSchema,
    'source.historyDetails': sourceControlHistoryDetailsSchema,
    'source.action': sourceControlActionResultSchema,
} as const satisfies Record<ExtensionViewOperationName, z.ZodType>;

const extensionViewOperationResultSchema = z.union([
    extensionViewOperationResultSchemas['badge.snapshot'],
    extensionViewOperationResultSchemas['source.snapshot'],
    extensionViewOperationResultSchemas['source.historyPage'],
    extensionViewOperationResultSchemas['source.historyDetails'],
    extensionViewOperationResultSchemas['source.action'],
]);

export const extensionViewMethods = {
    'viewContainers.catalog': {
        ...commandPolicy('server', 'read'),
        params: z.object({}).default({}),
        result: viewCatalogSnapshotSchema,
    },
    'viewContainers.treeChildren': {
        ...commandPolicy('server', 'read'),
        params: z.object({
            viewId: viewIdSchema,
            parentHandle: z.string().min(1).max(512).optional(),
            requestId: identifierSchema,
            /**
             * Rejected with CANCELLED once no longer the active scope, like `viewContainers.viewOperation`.
             */
            context: extensionViewEventContextSchema,
        }),
        result: treeChildrenResultSchema,
    },
    'viewContainers.viewOperation': {
        ...commandPolicy('server', 'control'),
        params: extensionViewOperationSchema,
        result: extensionViewOperationResultSchema,
    },
    'viewContainers.executeCommand': {
        ...commandPolicy('server', 'control'),
        params: z.object({
            commandId: extensionCommandIdSchema,
            arguments: z.array(z.unknown()).max(MAX_EXTENSION_COMMAND_ARGUMENTS).default([]),
            /**
             * The Session the command was issued in. Rejected with CANCELLED once no longer the active scope: a command
             * waiting behind another repository mutation must not start against a Session the user switched to.
             */
            context: extensionViewEventContextSchema,
        }),
        result: extensionCommandResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;
/* eslint-enable unicorn/max-nested-calls */
