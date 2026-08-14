import { z } from 'zod';

import { identifierSchema, pathSchema } from '../domain/domain.js';

export const desktopStatusResultSchema = z.discriminatedUnion('state', [
    z.object({ state: z.literal('offline') }),
    z.object({
        state: z.enum(['background', 'window']),
        generation: z.number().int().positive(),
    }),
]);

export const desktopTargetResultSchema = z.object({
    generation: z.number().int().positive(),
    projectId: identifierSchema,
    sessionId: identifierSchema,
});

export const desktopOpenParamsSchema = z.object({
    path: pathSchema,
    sessionId: identifierSchema.optional(),
    launchIfNeeded: z.boolean().default(true),
});

const hostDesktopRead = {
    owner: 'host',
    effect: 'read',
    requiredCapabilities: ['desktop.window'],
    idempotency: 'none',
} as const;
const hostDesktopControl = {
    owner: 'host',
    effect: 'control',
    requiredCapabilities: ['desktop.window'],
    idempotency: 'request',
} as const;
const noParams = z.object({}).default({});

/** Host-owned commands that route only bounded native-window operations to the current Desktop. */
export const desktopHostMethods = {
    'desktop.status': { ...hostDesktopRead, params: noParams, result: desktopStatusResultSchema },
    'desktop.focus': {
        ...hostDesktopControl,
        params: z.object({ launchIfNeeded: z.boolean().default(false) }).default({
            launchIfNeeded: false,
        }),
        result: z.object({ state: z.literal('focused'), generation: z.number().int().positive() }),
    },
    'desktop.openPath': {
        ...hostDesktopControl,
        params: desktopOpenParamsSchema,
        /** Main has redeemed and dispatched the target; Renderer editor work completes asynchronously. */
        result: desktopTargetResultSchema.extend({ state: z.literal('requested') }),
    },
    'desktop.openProject': {
        ...hostDesktopControl,
        params: desktopOpenParamsSchema,
        result: desktopTargetResultSchema.extend({ state: z.literal('requested') }),
    },
    'desktop.openFile': {
        ...hostDesktopControl,
        params: desktopOpenParamsSchema,
        result: desktopTargetResultSchema.extend({ state: z.literal('requested') }),
    },
    'files.reveal': {
        ...hostDesktopControl,
        params: desktopOpenParamsSchema.extend({ launchIfNeeded: z.boolean().default(false) }),
        result: desktopTargetResultSchema.extend({ state: z.literal('revealed') }),
    },
} as const;
