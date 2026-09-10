/* eslint-disable unicorn/max-nested-calls -- Declarative Zod schemas intentionally compose bounded validators inline. */
import { z } from 'zod';

import { identifierSchema } from '../domain/domain.js';
import {
    extensionViewEventContextSchema,
    sourceControlActionResultSchema,
    sourceControlHistoryDetailsSchema,
    sourceControlHistoryPageSchema,
    sourceControlViewModelSchema,
    viewBadgeSchema,
    viewIdSchema,
} from '../domain/views.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

const common = {
    viewId: viewIdSchema,
    requestId: identifierSchema,
    context: extensionViewEventContextSchema,
};

const extensionViewOperationSchema = z.discriminatedUnion('operation', [
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

export const extensionViewOperationResultSchemas = {
    'badge.snapshot': viewBadgeSchema.nullable(),
    'source.snapshot': sourceControlViewModelSchema,
    'source.historyPage': sourceControlHistoryPageSchema,
    'source.historyDetails': sourceControlHistoryDetailsSchema,
    'source.action': sourceControlActionResultSchema,
} as const satisfies Record<z.infer<typeof extensionViewOperationSchema>['operation'], z.ZodType>;

const extensionViewOperationResultSchema = z.union([
    extensionViewOperationResultSchemas['badge.snapshot'],
    extensionViewOperationResultSchemas['source.snapshot'],
    extensionViewOperationResultSchemas['source.historyPage'],
    extensionViewOperationResultSchemas['source.historyDetails'],
    extensionViewOperationResultSchemas['source.action'],
]);

export const extensionViewMethods = {
    'viewContainers.viewOperation': {
        ...commandPolicy('server', 'control'),
        params: extensionViewOperationSchema,
        result: extensionViewOperationResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;
/* eslint-enable unicorn/max-nested-calls */
