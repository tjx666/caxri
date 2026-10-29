/**
 * Schemas for the Terminal launch plan Server Core sends with `terminal.start`: the resolved executable, argv, and
 * environment for the shell and an optional Agent, plus the initial grid size, snapshot, output recovery, and colors.
 * Split from `protocol.ts` so the request envelope stays readable; the plan is validated there like every other param.
 */

import {
    agentProviderSchema,
    identifierSchema,
    pathSchema,
    terminalRecordSchema,
    terminalSnapshotSchema,
} from '@caxri/protocol';
import { z } from 'zod';

export const terminalGridSizeSchema = z
    .object({
        cols: z.number().int().positive().max(10_000),
        rows: z.number().int().positive().max(10_000),
    })
    .strict();

/**
 * The default colors the host answers OSC 10/11 queries with; fixed at launch and refreshed by `terminal.configure`.
 */
export const terminalColorsSchema = z
    .object({
        background: z.string().min(1).max(100),
        foreground: z.string().min(1).max(100),
    })
    .strict();

const environmentSchema = z
    .record(z.string().min(1).max(256), z.string().max(64 * 1024))
    .refine((environment) => Object.keys(environment).length <= 512, {
        message: 'Terminal launch environment exceeds 512 entries',
    });
const terminalArgumentsSchema = z.array(z.string().max(16_384)).max(256);

export const outputRecoverySettingsSchema = z
    .object({
        enabled: z.boolean(),
        patterns: z.array(z.string().max(8_192)).max(100),
        settleDelayMs: z.number().int().nonnegative().max(60_000),
        continueDelayMs: z.number().int().nonnegative().max(60_000),
    })
    .strict();

export const terminalLaunchPlanSchema = z
    .object({
        record: terminalRecordSchema,
        executable: pathSchema,
        args: terminalArgumentsSchema,
        environment: environmentSchema,
        agent: z
            .object({
                launchId: identifierSchema,
                provider: agentProviderSchema,
                executable: pathSchema,
                args: terminalArgumentsSchema,
                environment: environmentSchema,
            })
            .strict()
            .optional(),
        initialSnapshot: terminalSnapshotSchema.optional(),
        initialSize: terminalGridSizeSchema.optional(),
        outputRecovery: outputRecoverySettingsSchema.optional(),
        colors: terminalColorsSchema.optional(),
    })
    .strict();
