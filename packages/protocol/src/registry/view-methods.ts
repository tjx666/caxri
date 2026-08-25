/* eslint-disable unicorn/max-nested-calls -- Declarative Zod schemas intentionally compose bounded validators inline. */
import { z } from 'zod';

import {
    canceledResultSchema,
    fileEntrySchema,
    fileSearchModeSchema,
    fileSearchResultSchema,
    gitCommitDetailsSchema,
    identifierSchema,
    movedFileEntrySchema,
    mutableFileEntrySchema,
    pathSchema,
} from '../domain/domain.js';
import {
    gitCommitPageSchema,
    gitPullRequestChangesSchema,
    gitSummarySchema,
} from '../domain/git.js';
import { extensionViewEventContextSchema, viewIdSchema } from '../domain/views.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

const common = {
    viewId: viewIdSchema,
    requestId: identifierSchema,
    context: extensionViewEventContextSchema,
};
const operationId = { operationId: identifierSchema };
const repoId = { repositoryId: identifierSchema };
const fileNameSchema = z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine(
        (name) =>
            name !== '.' &&
            name !== '..' &&
            !name.includes('/') &&
            !name.includes('\\') &&
            !name.includes('\0'),
        'File name must not contain path separators',
    );

const extensionFileOperationBase = {
    id: identifierSchema,
    sessionId: identifierSchema,
    workbenchProjectId: identifierSchema.optional(),
    phase: z.enum(['pre_stage', 'staged', 'completed', 'failed', 'canceled']),
    startedAt: z.number(),
    updatedAt: z.number(),
    error: z
        .object({ code: z.string().min(1).max(64), message: z.string().min(1).max(1_024) })
        .optional(),
};
const extensionFileMutationOperationSchema = z.discriminatedUnion('kind', [
    z.object({
        ...extensionFileOperationBase,
        kind: z.literal('create'),
        input: z.object({
            directory: pathSchema,
            name: fileNameSchema,
            kind: z.enum(['file', 'directory']),
        }),
        expectedResult: mutableFileEntrySchema.optional(),
        result: mutableFileEntrySchema.optional(),
    }),
    z.object({
        ...extensionFileOperationBase,
        kind: z.literal('rename'),
        input: z.object({ path: pathSchema, name: fileNameSchema }),
        expectedResult: movedFileEntrySchema.optional(),
        result: movedFileEntrySchema.optional(),
    }),
    z.object({
        ...extensionFileOperationBase,
        kind: z.literal('move'),
        input: z.object({
            path: pathSchema,
            directory: pathSchema,
            conflict: z.enum(['reject', 'rename', 'replace']),
        }),
        expectedResult: movedFileEntrySchema.optional(),
        result: movedFileEntrySchema.optional(),
    }),
]);

const extensionViewOperationSchema = z.discriminatedUnion('operation', [
    z.object({
        ...common,
        operation: z.literal('files.list'),
        arguments: z.object({ directory: pathSchema.optional() }),
    }),
    z.object({
        ...common,
        operation: z.literal('files.search'),
        arguments: z.object({
            mode: fileSearchModeSchema,
            query: z.string().min(1).max(256),
            caseSensitive: z.boolean().default(false),
            wholeWord: z.boolean().default(false),
            regex: z.boolean().default(false),
            include: z.string().max(512).default(''),
            exclude: z.string().max(512).default(''),
        }),
    }),
    z.object({
        ...common,
        operation: z.literal('files.create'),
        arguments: z.object({
            ...operationId,
            directory: pathSchema,
            name: fileNameSchema,
            kind: z.enum(['file', 'directory']).default('file'),
        }),
    }),
    z.object({
        ...common,
        operation: z.literal('files.copy'),
        arguments: z.object({ path: pathSchema, directory: pathSchema }),
    }),
    z.object({
        ...common,
        operation: z.literal('files.rename'),
        arguments: z.object({ ...operationId, path: pathSchema, name: fileNameSchema }),
    }),
    z.object({
        ...common,
        operation: z.literal('files.move'),
        arguments: z.object({
            ...operationId,
            path: pathSchema,
            directory: pathSchema,
            conflict: z.enum(['reject', 'rename', 'replace']).default('reject'),
        }),
    }),
    z.object({
        ...common,
        operation: z.literal('files.operation.get'),
        arguments: z.object(operationId),
    }),
    z.object({ ...common, operation: z.literal('files.operation.list'), arguments: z.object({}) }),
    z.object({
        ...common,
        operation: z.literal('files.operation.cancel'),
        arguments: z.object(operationId),
    }),
    z.object({
        ...common,
        operation: z.literal('files.operation.acknowledge'),
        arguments: z.object(operationId),
    }),
    z.object({
        ...common,
        operation: z.literal('files.trash'),
        arguments: z.object({
            path: pathSchema,
            hasUnsavedChanges: z.boolean().optional(),
        }),
    }),
    z.object({
        ...common,
        operation: z.literal('files.reveal'),
        arguments: z.object({ path: pathSchema }),
    }),
    z.object({
        ...common,
        operation: z.literal('git.summary'),
        arguments: z.object({ refresh: z.number().int().nonnegative().default(0) }),
    }),
    z.object({ ...common, operation: z.literal('git.sync'), arguments: z.object(repoId) }),
    z.object({
        ...common,
        operation: z.literal('git.discard'),
        arguments: z.object({
            ...repoId,
            repositoryName: z.string().min(1).max(1_024),
            scope: z.discriminatedUnion('kind', [
                z.object({
                    kind: z.literal('all'),
                    fileCount: z.number().int().positive().max(100_000),
                }),
                z.object({ kind: z.literal('file'), path: pathSchema, untracked: z.boolean() }),
            ]),
        }),
    }),
    z.object({
        ...common,
        operation: z.literal('git.pullRequestChanges'),
        arguments: z.object({
            ...repoId,
            refresh: z.number().int().nonnegative().default(0),
        }),
    }),
    z.object({
        ...common,
        operation: z.literal('git.commits'),
        arguments: z.object({
            ...repoId,
            offset: z.number().int().nonnegative().max(10_000).default(0),
            pageSize: z.number().int().min(1).max(50).default(25),
            path: pathSchema.optional(),
        }),
    }),
    z.object({
        ...common,
        operation: z.literal('git.commitDetails'),
        arguments: z.object({
            ...repoId,
            sha: z.string().regex(/^[0-9a-f]{40}$/),
            path: pathSchema.optional(),
        }),
    }),
    z.object({
        ...common,
        operation: z.literal('git.remoteHost'),
        arguments: z.object(repoId),
    }),
]);

export const extensionViewOperationResultSchemas = {
    'files.list': z.array(fileEntrySchema),
    'files.search': fileSearchResultSchema,
    'files.create': mutableFileEntrySchema,
    'files.copy': mutableFileEntrySchema,
    'files.rename': movedFileEntrySchema,
    'files.move': movedFileEntrySchema,
    'files.operation.get': extensionFileMutationOperationSchema.nullable(),
    'files.operation.list': z.array(extensionFileMutationOperationSchema).max(256),
    'files.operation.cancel': extensionFileMutationOperationSchema,
    'files.operation.acknowledge': z.null(),
    'files.trash': z.union([canceledResultSchema, mutableFileEntrySchema]),
    'files.reveal': z.null(),
    'git.summary': gitSummarySchema,
    'git.sync': z.null(),
    'git.discard': z.union([canceledResultSchema, z.null()]),
    'git.pullRequestChanges': gitPullRequestChangesSchema.nullable(),
    'git.commits': gitCommitPageSchema,
    'git.commitDetails': gitCommitDetailsSchema,
    'git.remoteHost': z.string().nullable(),
} as const satisfies Record<z.infer<typeof extensionViewOperationSchema>['operation'], z.ZodType>;

const extensionViewOperationResultSchema = z.union([
    extensionViewOperationResultSchemas['files.list'],
    extensionViewOperationResultSchemas['files.search'],
    extensionViewOperationResultSchemas['files.create'],
    extensionViewOperationResultSchemas['files.rename'],
    extensionViewOperationResultSchemas['files.operation.get'],
    extensionViewOperationResultSchemas['files.operation.list'],
    extensionViewOperationResultSchemas['files.operation.cancel'],
    extensionViewOperationResultSchemas['files.trash'],
    extensionViewOperationResultSchemas['files.reveal'],
    extensionViewOperationResultSchemas['git.summary'],
    extensionViewOperationResultSchemas['git.discard'],
    extensionViewOperationResultSchemas['git.pullRequestChanges'],
    extensionViewOperationResultSchemas['git.commits'],
    extensionViewOperationResultSchemas['git.commitDetails'],
    extensionViewOperationResultSchemas['git.remoteHost'],
]);

export const extensionViewMethods = {
    'viewContainers.viewOperation': {
        ...commandPolicy('host', 'control'),
        params: extensionViewOperationSchema,
        result: extensionViewOperationResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;
/* eslint-enable unicorn/max-nested-calls */
