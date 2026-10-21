import { agentDelegationSettingsSchema, CaxriError } from '@caxri/protocol';
import type { ParseError } from 'jsonc-parser/lib/esm/main.js';
/**
 * The UMD entry wraps dynamic require calls that Bun cannot include in the standalone Node bundle.
 */
import { parse } from 'jsonc-parser/lib/esm/main.js';
import { z } from 'zod';

import { readBoundedTextFile } from './text-file';
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
    const source = await readBoundedTextFile(path, 1_048_576, 'Configuration import');
    try {
        const errors: ParseError[] = [];
        const input: unknown = parse(source, errors, { allowTrailingComma: true });
        if (errors.length > 0) throw new Error('Invalid JSONC');
        return { settings: convertDelegationConfig(input), dryRun: mode !== '--apply' };
    } catch (error) {
        // Never include configuration values or private instructions in CLI diagnostics.
        const fields =
            error instanceof z.ZodError
                ? error.issues.map((issue) => {
                      const field = issue.path.length > 0 ? issue.path.join('.') : 'configuration';
                      // Unknown keys are arbitrary source text; report their location without echoing them.
                      const reason =
                          issue.code === 'unrecognized_keys'
                              ? 'Unknown fields are not supported'
                              : issue.message;
                      return `${field}: ${reason}`;
                  })
                : [];
        throw new CaxriError(
            'VALIDATION',
            fields.length > 0
                ? `Invalid delegation configuration: ${fields.join('; ')}`
                : 'Invalid delegation JSONC configuration',
        );
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
