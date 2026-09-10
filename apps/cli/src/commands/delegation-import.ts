import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { agentDelegationSettingsSchema, CaxriError } from '@caxri/protocol';
import type { ParseError } from 'jsonc-parser';
import { parse } from 'jsonc-parser';
import { z } from 'zod';

import type { RemoteCommandDefinition } from './types';

const selection = {
    harness: z.string(),
    model: z.string().optional(),
    effort: z.string().optional(),
    useWhen: z.string().optional(),
    dontUseWhen: z.string().optional(),
};
const bindingSchema = z.strictObject(selection);
const presetSchema = z.strictObject({
    ...selection,
    name: z.string(),
    useWhen: z.string(),
    instructions: z.string().optional(),
});
const callerSchema = z.strictObject({
    agents: z.record(z.string(), bindingSchema).optional(),
    exclude: z.array(z.string()).optional(),
    prepend: z.string().optional(),
    append: z.string().optional(),
});
const sourceSchema = z.strictObject({
    maxDepth: z.number(),
    agents: z.array(presetSchema),
    callers: z.record(z.string(), callerSchema).optional(),
});

/**
 * Keep caller bindings as whole tuples; omitted model/effort must not inherit another provider's values.
 */
export function convertDelegationConfig(input: unknown) {
    const source = sourceSchema.parse(input);
    return agentDelegationSettingsSchema.parse({
        maxDepth: source.maxDepth,
        presets: source.agents.map(({ harness, ...preset }) => ({ ...preset, provider: harness })),
        callers: Object.fromEntries(
            Object.entries(source.callers ?? {}).map(([caller, { agents, ...rest }]) => [
                caller,
                {
                    ...rest,
                    ...(agents && {
                        presets: Object.fromEntries(
                            Object.entries(agents).map(([name, { harness, ...binding }]) => [
                                name,
                                { ...binding, provider: harness },
                            ]),
                        ),
                    }),
                },
            ]),
        ),
    });
}

async function importParameters(tokens: readonly string[]) {
    let path: string | undefined;
    let mode: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (
            token === '--from' &&
            !path &&
            tokens[index + 1] &&
            !tokens[index + 1].startsWith('--')
        ) {
            path = tokens[index + 1];
            index += 1;
        } else if (!mode && ['--apply', '--dry-run'].includes(token)) mode = token;
        else
            throw new CaxriError(
                'VALIDATION',
                'Expected --from <file> and at most one of --dry-run or --apply',
            );
    }
    if (!path)
        throw new CaxriError('VALIDATION', 'Configuration import requires an explicit --from file');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await file.stat();
        const limit = 1_048_576;
        if (!info.isFile() || info.size > limit)
            throw new CaxriError(
                'VALIDATION',
                'Import requires a regular JSONC file of at most 1 MiB',
            );
        const buffer = Buffer.alloc(limit + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > limit)
            throw new CaxriError('VALIDATION', 'Configuration import exceeds 1 MiB');
        try {
            const errors: ParseError[] = [];
            const input: unknown = parse(buffer.subarray(0, bytesRead).toString('utf8'), errors, {
                allowTrailingComma: true,
            });
            if (errors.length > 0) throw new Error('Invalid JSONC');
            return { settings: convertDelegationConfig(input), dryRun: mode !== '--apply' };
        } catch (error) {
            // Never include configuration values or private instructions in CLI diagnostics.
            const fields =
                error instanceof z.ZodError
                    ? error.issues.map(({ path: field }) =>
                          field.length > 0 ? field.join('.') : 'preset or caller constraints',
                      )
                    : [];
            throw new CaxriError(
                'VALIDATION',
                fields.length > 0
                    ? `Unsupported configuration fields: ${fields.join(', ')}`
                    : 'Invalid delegation JSONC configuration',
            );
        }
    } finally {
        await file.close();
    }
}

export const DELEGATION_IMPORT_COMMAND: RemoteCommandDefinition = {
    kind: 'remote',
    path: ['agent', 'delegate', 'import'],
    method: 'settings.delegation.import',
    requiresHumanOwner: true,
    summary: 'Preview or explicitly apply dianjiang presets to this profile.',
    usage: '--from <file> [--dry-run | --apply]',
    confirmation: "Replace this profile's delegation presets and caller rules?",
    mutates: (parameters) => (parameters as { dryRun: boolean }).dryRun === false,
    parseParams: importParameters,
};
