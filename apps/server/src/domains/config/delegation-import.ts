import { createHash } from 'node:crypto';

import type {
    AgentDelegationSettings,
    DelegationImportIssue,
    DelegationImportParameters,
    ImportedDelegation,
} from '@caxri/protocol';
import {
    CaxriError,
    convertDianjiangConfig,
    DELEGATION_IMPORT_REJECTED_MESSAGE,
    delegationImportIssues,
    delegationPresetNameSchema,
    diffDelegationSettings,
    MAX_CONFIGURATION_SOURCE_BYTES,
    mergeDelegationSettings,
} from '@caxri/protocol';
import { parseJsonc } from '@caxri/system';
import { z } from 'zod';

import { setJsoncValue } from './reconcile';

/**
 * Same digest `settingsInspection` reports, so a preview's revision can be handed back as `expectedRevision`.
 */
function settingsSourceRevision(source: string): string {
    return createHash('sha256').update(source).digest('hex');
}

/**
 * The only error shape an import rejection takes: a fixed message plus value-free issues. Servers and clients log
 * messages, so nothing taken from the file may appear in the message.
 */
function rejectImport(issues: DelegationImportIssue[]): never {
    throw new CaxriError('VALIDATION', DELEGATION_IMPORT_REJECTED_MESSAGE, { issues });
}

/**
 * Names the file gives its own presets; a path may keep a name only when the file defines it.
 */
function presetNamesIn(input: unknown): Set<string> {
    const agents = (input as { agents?: unknown } | null)?.agents;
    if (!Array.isArray(agents)) return new Set();
    return new Set(
        agents.flatMap((agent: unknown) => {
            const name = (agent as { name?: unknown } | null)?.name;
            return typeof name === 'string' && delegationPresetNameSchema.safeParse(name).success
                ? [name]
                : [];
        }),
    );
}

function parseSource(sourceText: string): ImportedDelegation {
    let input: unknown;
    try {
        input = parseJsonc(sourceText);
    } catch (error) {
        // `parseJsonc` words its failure as "<code> at line N, column M"; only the position is forwarded.
        const match = /line (\d+), column (\d+)/u.exec(error instanceof Error ? error.message : '');
        return rejectImport([
            {
                stage: 'source',
                path: '',
                reason: 'invalid_jsonc',
                ...(match && { line: Number(match[1]), column: Number(match[2]) }),
            },
        ]);
    }
    try {
        return convertDianjiangConfig(input);
    } catch (error) {
        if (error instanceof z.ZodError)
            return rejectImport(delegationImportIssues(error, 'source', presetNamesIn(input)));
        throw error;
    }
}

/**
 * Plans one dianjiang import against the current settings without writing. Replaces the whole `agents.delegation` node,
 * so comments written inside it are not kept; every byte outside it is.
 */
export function planDelegationImport(
    current: AgentDelegationSettings,
    currentSource: string,
    { sourceText, mode, dryRun, expectedRevision }: DelegationImportParameters,
) {
    const revision = settingsSourceRevision(currentSource);
    if (!dryRun && expectedRevision && expectedRevision !== revision)
        throw new CaxriError('CONFLICT', 'Settings changed since this preview', {
            reason: 'stale_preview',
        });
    const merged = mergeDelegationSettings(current, parseSource(sourceText), mode);
    if (!merged.ok) return rejectImport(merged.issues);
    const nextSource = setJsoncValue(currentSource, ['agents.delegation'], merged.value);
    // The input limit does not bound the merged file: a small import can still push settings over the ceiling.
    if (new TextEncoder().encode(nextSource).byteLength > MAX_CONFIGURATION_SOURCE_BYTES)
        rejectImport([{ stage: 'result', path: '', reason: 'too_large' }]);
    const diff = diffDelegationSettings(current, merged.value);
    return {
        nextSource,
        result: {
            dryRun,
            mode,
            changed: JSON.stringify(current) !== JSON.stringify(merged.value),
            revision,
            diff,
            presetNames: merged.value.presets.map(({ name }) => name),
            maxDepth: merged.value.maxDepth,
        },
    };
}
