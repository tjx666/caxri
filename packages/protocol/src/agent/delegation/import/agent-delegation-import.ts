import { z } from 'zod';

import { configurationSourceSchema as configSourceSchema } from '../../../configuration/configuration-contract.js';
import { agentProviderSchema } from '../../agents.js';
import type { AgentDelegationSettings } from '../agent-delegation-settings.js';
import {
    agentDelegationSettingsSchema,
    delegationPresetNameSchema,
    MAX_DELEGATION_PRESETS,
} from '../agent-delegation-settings.js';
import type { DelegationImportIssue } from './agent-delegation-import-issues.js';
import {
    delegationImportIssues,
    delegationImportIssueSchema,
} from './agent-delegation-import-issues.js';

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
const dianjiangSourceSchema = z.strictObject({
    maxDepth: z.number(),
    agents: z.array(presetSchema),
    callers: z.record(z.string(), callerSchema).optional(),
});

/**
 * The part of the delegation settings a dianjiang file owns. `readChildChat` and `approval` are Caxri switches the file
 * has no say in, so an import never resets them.
 */
export type ImportedDelegation = Pick<AgentDelegationSettings, 'callers' | 'maxDepth' | 'presets'>;

/**
 * Converts a dianjiang `delegation.jsonc` value. Keeps caller bindings as whole tuples; omitted model/effort must not
 * inherit another provider's values. Throws a `ZodError` whose issues belong to the `source` stage.
 */
export function convertDianjiangConfig(input: unknown): ImportedDelegation {
    const source = dianjiangSourceSchema.parse(input);
    const { maxDepth, presets, callers } = agentDelegationSettingsSchema.parse({
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
    return { maxDepth, presets, callers };
}

const delegationImportModeSchema = z.enum(['merge', 'replace']);
export type DelegationImportMode = z.infer<typeof delegationImportModeSchema>;

export type DelegationMergeResult =
    { ok: true; value: AgentDelegationSettings } | { ok: false; issues: DelegationImportIssue[] };

/**
 * Combines the file with the current settings. Merge works per preset name and per caller provider and keeps every
 * entry whole; it leaves `maxDepth` alone, because importing presets must not change the global delegation depth.
 * Replace makes presets, callers and `maxDepth` exactly the file's. The result is validated again (preset cap, caller
 * references), since a valid file can still produce invalid settings.
 */
export function mergeDelegationSettings(
    current: AgentDelegationSettings,
    imported: ImportedDelegation,
    mode: DelegationImportMode,
): DelegationMergeResult {
    let presets = imported.presets;
    let callers = imported.callers;
    let { maxDepth } = imported;
    if (mode === 'merge') {
        const byName = new Map(imported.presets.map((preset) => [preset.name, preset]));
        const kept = current.presets.map((preset) => byName.get(preset.name) ?? preset);
        const known = new Set(current.presets.map((preset) => preset.name));
        presets = [...kept, ...imported.presets.filter((preset) => !known.has(preset.name))];
        callers = { ...current.callers, ...imported.callers };
        ({ maxDepth } = current);
    }
    const parsed = agentDelegationSettingsSchema.safeParse({
        ...current,
        maxDepth,
        presets,
        callers,
    });
    return parsed.success
        ? { ok: true, value: parsed.data }
        : {
              ok: false,
              issues: delegationImportIssues(
                  parsed.error,
                  'result',
                  new Set(presets.map(({ name }) => name)),
              ),
          };
}

const presetFieldSchema = z.enum([
    'provider',
    'model',
    'effort',
    'useWhen',
    'dontUseWhen',
    'instructions',
]);
const callerFieldSchema = z.enum(['presets', 'exclude', 'prepend', 'append']);
const presetNames = z.array(delegationPresetNameSchema).max(MAX_DELEGATION_PRESETS);

const changedPresetSchema = z.strictObject({
    name: delegationPresetNameSchema,
    fields: z.array(presetFieldSchema).min(1),
});
const changedCallerSchema = z.strictObject({
    provider: agentProviderSchema,
    fields: z.array(callerFieldSchema).min(1),
});

/**
 * What an import changes, by names and field names only; no preset text reaches a preview.
 */
const delegationImportDiffSchema = z.strictObject({
    presets: z.strictObject({
        added: presetNames,
        changed: z.array(changedPresetSchema).max(MAX_DELEGATION_PRESETS),
        removed: presetNames,
        unchanged: presetNames,
    }),
    callers: z.strictObject({
        added: z.array(agentProviderSchema),
        removed: z.array(agentProviderSchema),
        changed: z.array(changedCallerSchema),
    }),
    settings: z.array(z.enum(['maxDepth'])),
});

export type DelegationImportDiff = z.infer<typeof delegationImportDiffSchema>;

function isSame(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (typeof left !== 'object' || typeof right !== 'object' || !left || !right) return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    const leftKeys = Object.keys(left).filter(
        (key) => (left as Record<string, unknown>)[key] !== undefined,
    );
    const rightKeys = Object.keys(right).filter(
        (key) => (right as Record<string, unknown>)[key] !== undefined,
    );
    return (
        leftKeys.length === rightKeys.length &&
        leftKeys.every((key) =>
            isSame((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
        )
    );
}

function changedFields<Field extends string>(
    fields: readonly Field[],
    before: Readonly<Record<string, unknown>>,
    after: Readonly<Record<string, unknown>>,
): Field[] {
    return fields.filter((field) => !isSame(before[field], after[field]));
}

/**
 * Compares two settings values; a field the new preset leaves out counts as changed, since tuples stay whole.
 */
export function diffDelegationSettings(
    before: AgentDelegationSettings,
    after: AgentDelegationSettings,
): DelegationImportDiff {
    const previous = new Map(before.presets.map((preset) => [preset.name, preset]));
    const next = new Map(after.presets.map((preset) => [preset.name, preset]));
    const diff: DelegationImportDiff = {
        presets: { added: [], changed: [], removed: [], unchanged: [] },
        callers: { added: [], removed: [], changed: [] },
        settings: before.maxDepth === after.maxDepth ? [] : ['maxDepth'],
    };
    for (const [name, preset] of next) {
        const old = previous.get(name);
        if (!old) diff.presets.added.push(name);
        else {
            const fields = changedFields(presetFieldSchema.options, old, preset);
            if (fields.length > 0) diff.presets.changed.push({ name, fields });
            else diff.presets.unchanged.push(name);
        }
    }
    for (const name of previous.keys()) if (!next.has(name)) diff.presets.removed.push(name);
    for (const provider of agentProviderSchema.options) {
        const old = before.callers[provider];
        const caller = after.callers[provider];
        if (!old && caller) diff.callers.added.push(provider);
        else if (old && !caller) diff.callers.removed.push(provider);
        else if (old && caller) {
            const fields = changedFields(callerFieldSchema.options, old, caller);
            if (fields.length > 0) diff.callers.changed.push({ provider, fields });
        }
    }
    return diff;
}

/**
 * Parameters of `settings.delegation.import`. The Server parses `sourceText`; a client only reads a file.
 */
export const delegationImportParametersSchema = z.strictObject({
    sourceText: configSourceSchema,
    mode: delegationImportModeSchema.default('merge'),
    dryRun: z.boolean().default(true),
    /**
     * Revision of the settings the preview was computed against; an apply fails with `stale_preview` if they changed.
     */
    expectedRevision: z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .optional(),
});

export type DelegationImportParameters = z.output<typeof delegationImportParametersSchema>;

export const delegationImportResultSchema = z.strictObject({
    dryRun: z.boolean(),
    mode: delegationImportModeSchema,
    changed: z.boolean(),
    /**
     * Revision of the settings source before this call, to pass back as `expectedRevision`.
     */
    revision: z.string().regex(/^[0-9a-f]{64}$/u),
    diff: delegationImportDiffSchema,
    presetNames: z.array(delegationPresetNameSchema).max(MAX_DELEGATION_PRESETS),
    maxDepth: z.number().int(),
});

/**
 * `details` of the VALIDATION error an import raises.
 */
export const delegationImportErrorDetailsSchema = z.strictObject({
    issues: z.array(delegationImportIssueSchema).min(1).max(32),
});
