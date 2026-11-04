import type { z } from 'zod';
import { z as zod } from 'zod';

import { agentProviderIds } from '../../agents.js';

/**
 * Fixed wire message of a rejected import. Locations travel in `details.issues`, because the Server and Desktop log
 * every error message and an issue path can otherwise echo text the user wrote.
 */
export const DELEGATION_IMPORT_REJECTED_MESSAGE = 'Delegation presets could not be imported';

const PROVIDER_IDS: ReadonlySet<string> = new Set(agentProviderIds);

/**
 * Closed vocabulary of why an import was rejected. A reason never carries a value from the file.
 */
const delegationImportReasonSchema = zod.enum([
    'invalid_jsonc',
    'too_large',
    'unknown_field',
    'missing',
    'wrong_type',
    'invalid_value',
    'too_long',
    'too_many',
    'duplicate_name',
    'unsupported_effort',
    'unknown_preset',
    'excluded_and_overridden',
]);

type DelegationImportReason = z.infer<typeof delegationImportReasonSchema>;

/**
 * `source` issues come from the file itself; `result` issues come from the settings the import would produce.
 */
export const delegationImportIssueSchema = zod.strictObject({
    stage: zod.enum(['source', 'result']),
    path: zod.string().max(256),
    reason: delegationImportReasonSchema,
    line: zod.number().int().optional(),
    column: zod.number().int().optional(),
});

export type DelegationImportIssue = z.infer<typeof delegationImportIssueSchema>;

/**
 * Field names of the dianjiang file and of the settings it becomes. Only these survive in a reported path.
 */
const KNOWN_FIELDS = new Set([
    'maxDepth',
    'agents',
    'presets',
    'callers',
    'harness',
    'provider',
    'model',
    'effort',
    'name',
    'useWhen',
    'dontUseWhen',
    'instructions',
    'exclude',
    'prepend',
    'append',
]);

/**
 * Rewrites a zod path by schema context. A segment is kept only where the schema fixes what it can be: an array index,
 * a known field, a provider id where a caller is keyed, or a key naming a preset the caller already knows
 * (`knownNames`). Every other segment (an unknown field, an arbitrary record key) is masked as `*`, so the path never
 * echoes text from the file.
 */
export function sanitizeDelegationIssuePath(
    path: readonly PropertyKey[],
    knownNames: ReadonlySet<string> = new Set(),
): string {
    const out: string[] = [];
    let expect: 'field' | 'caller' | 'binding' = 'field';
    let isInsideCaller = false;
    for (const segment of path) {
        if (typeof segment === 'number') {
            out.push(String(segment));
            continue;
        }
        const key = String(segment);
        if (expect === 'caller') {
            out.push(PROVIDER_IDS.has(key) ? key : '*');
            expect = 'field';
            isInsideCaller = true;
        } else if (expect === 'binding') {
            out.push(knownNames.has(key) ? key : '*');
            expect = 'field';
        } else if (KNOWN_FIELDS.has(key)) {
            out.push(key);
            if (key === 'callers' && !isInsideCaller) expect = 'caller';
            else if (isInsideCaller && (key === 'agents' || key === 'presets')) expect = 'binding';
        } else out.push('*');
    }
    return out.join('.').slice(0, 256);
}

function reasonFor(issue: z.core.$ZodIssue): DelegationImportReason {
    switch (issue.code) {
        case 'unrecognized_keys':
            return 'unknown_field';
        case 'invalid_type':
            // Zod omits `input` from issues, and only the message distinguishes an absent value; it is read here, never
            // forwarded.
            return issue.message.endsWith('received undefined') ? 'missing' : 'wrong_type';
        case 'too_big':
            if (issue.origin === 'array' || issue.origin === 'set') return 'too_many';
            return issue.origin === 'string' ? 'too_long' : 'invalid_value';
        case 'custom': {
            const parsed = delegationImportReasonSchema.safeParse(
                (issue.params as { reason?: unknown } | undefined)?.reason,
            );
            return parsed.success ? parsed.data : 'invalid_value';
        }
        default:
            return 'invalid_value';
    }
}

/**
 * Maps zod issues to value-free issues. `issue.message` is never forwarded, because zod messages and key lists can
 * quote the input.
 */
export function delegationImportIssues(
    error: z.ZodError,
    stage: DelegationImportIssue['stage'],
    knownNames?: ReadonlySet<string>,
): DelegationImportIssue[] {
    return error.issues.slice(0, 32).map((issue) => ({
        stage,
        path: sanitizeDelegationIssuePath(issue.path, knownNames),
        reason: reasonFor(issue),
    }));
}

/**
 * English one-liner for the CLI. Built from the closed vocabulary, so it is as value-free as the issues.
 */
export function formatDelegationImportIssues(issues: readonly DelegationImportIssue[]): string {
    return issues
        .map((issue) => {
            const where = issue.path || 'file';
            const position =
                issue.line === undefined
                    ? ''
                    : ` (line ${issue.line}, column ${issue.column ?? 1})`;
            return `${issue.stage === 'result' ? 'after merging: ' : ''}${where}: ${issue.reason}${position}`;
        })
        .join('; ');
}
