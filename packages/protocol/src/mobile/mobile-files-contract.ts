import { z } from 'zod';

import { fileEntrySchema } from '../domain/domain.js';
import { identifierSchema, pathSchema } from '../domain/identifiers.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { principalSchema } from '../transport/principal.js';
import { MOBILE_FILES_MAX_ENTRIES, MOBILE_FILES_READ_MAX_BYTES } from './mobile-file-limits.js';

const mobileFilesListParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    directory: pathSchema.optional(),
});

const mobileFilesListResultSchema = z.strictObject({
    entries: z.array(fileEntrySchema).max(MOBILE_FILES_MAX_ENTRIES),
    truncated: z.boolean(),
});

const mobileFilesReadParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    path: pathSchema,
});

const mobileFilesReadResultSchema = z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('available'),
        path: pathSchema,
        content: z
            .string()
            .refine(
                (content) =>
                    new TextEncoder().encode(content).length <= MOBILE_FILES_READ_MAX_BYTES,
                'Mobile file read exceeds the byte limit',
            ),
        mtimeMs: z.number(),
        size: z.number(),
        contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
        readOnly: z.boolean().optional(),
    }),
    z.strictObject({ status: z.literal('binary') }),
    z.strictObject({ status: z.literal('oversized') }),
]);

const mobileFilesWriteParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    path: pathSchema,
    content: z
        .string()
        .refine(
            (content) => new TextEncoder().encode(content).length <= MOBILE_FILES_READ_MAX_BYTES,
            'Mobile file write exceeds the byte limit',
        ),
    expectedContentHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

const mobileFilesSearchResultSchema = z.strictObject({
    paths: z.array(z.string().min(1).max(2_048)).max(40),
    truncated: z.boolean(),
});

/**
 * Session-scoped Files browsing, search, and conflict-checked text writes from a paired device.
 */
export const mobileFilesMethods = {
    'mobile.files.list': {
        ...commandPolicy('server', 'read', ['files.read']),
        params: mobileFilesListParametersSchema,
        result: mobileFilesListResultSchema,
    },
    'mobile.files.read': {
        ...commandPolicy('server', 'read', ['files.read']),
        params: mobileFilesReadParametersSchema,
        result: mobileFilesReadResultSchema,
    },
    'mobile.files.search': {
        ...commandPolicy('server', 'read', ['files.read']),
        params: z.strictObject({ sessionId: identifierSchema, query: z.string().min(1).max(100) }),
        result: mobileFilesSearchResultSchema,
    },
    'mobile.files.write': {
        ...commandPolicy('server', 'write', ['files.write']),
        params: mobileFilesWriteParametersSchema,
        result: mobileFilesReadResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export const mobileFilesInternalMethods = {
    'mobile.files.listInternal': {
        ...commandPolicy('server', 'read'),
        params: mobileFilesListParametersSchema.extend({ principal: principalSchema }),
        result: mobileFilesListResultSchema,
    },
    'mobile.files.readInternal': {
        ...commandPolicy('server', 'read'),
        params: mobileFilesReadParametersSchema.extend({ principal: principalSchema }),
        result: mobileFilesReadResultSchema,
    },
    'mobile.files.searchInternal': {
        ...commandPolicy('server', 'read'),
        params: mobileFilesMethods['mobile.files.search'].params.extend({
            principal: principalSchema,
        }),
        result: mobileFilesSearchResultSchema,
    },
    'mobile.files.writeInternal': {
        ...commandPolicy('server', 'write'),
        params: mobileFilesWriteParametersSchema.extend({ principal: principalSchema }),
        result: mobileFilesReadResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;
