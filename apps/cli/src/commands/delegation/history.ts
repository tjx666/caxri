import type { DelegationHistoryEntry, DelegationHistoryResult } from '@caxri/protocol';
import {
    CaxriError,
    delegationHistoryOutcomeSchema,
    MAX_DELEGATION_HISTORY_PAGE,
    MAX_DELEGATION_HISTORY_QUERY,
} from '@caxri/protocol';

import { formatRelativeTime } from '../../records-output';
import type { RemoteCommandDefinition } from '../types';

const outcomeUsage = delegationHistoryOutcomeSchema.options.join('|');
const valueFlags = new Set(['--query', '--outcome', '--limit', '--after']);

function historyParameters(tokens: readonly string[]) {
    const values = new Map<string, string>();
    for (let index = 0; index < tokens.length; index += 2) {
        const flag = tokens[index];
        if (!valueFlags.has(flag))
            throw new CaxriError('VALIDATION', `Unexpected argument: ${flag.split('=', 1)[0]}`);
        const value = tokens[index + 1];
        if (index + 1 >= tokens.length || values.has(flag))
            throw new CaxriError('VALIDATION', `Pass ${flag} once, with a value`);
        values.set(flag, value);
    }
    const query = values.get('--query')?.trim();
    if (query !== undefined && (query.length === 0 || query.length > MAX_DELEGATION_HISTORY_QUERY))
        throw new CaxriError(
            'VALIDATION',
            `--query must be 1 to ${MAX_DELEGATION_HISTORY_QUERY} characters`,
        );
    const outcome = values.get('--outcome');
    if (outcome !== undefined && !delegationHistoryOutcomeSchema.safeParse(outcome).success)
        throw new CaxriError('VALIDATION', `--outcome must be one of ${outcomeUsage}`);
    const limit = values.get('--limit');
    if (limit !== undefined && !/^\d+$/u.test(limit))
        throw new CaxriError('VALIDATION', '--limit requires a positive integer');
    if (limit !== undefined && (Number(limit) < 1 || Number(limit) > MAX_DELEGATION_HISTORY_PAGE))
        throw new CaxriError('VALIDATION', `--limit must be 1 to ${MAX_DELEGATION_HISTORY_PAGE}`);
    return {
        ...(query !== undefined && { query }),
        ...(outcome !== undefined && { outcome }),
        ...(limit !== undefined && { limit: Number(limit) }),
        ...(values.has('--after') && { after: values.get('--after') }),
    };
}

/**
 * Reported counters only: a counter the provider did not report is left out, never printed as 0, and a task with none
 * has no tokens line at all.
 */
function tokensLine(entry: DelegationHistoryEntry): string | undefined {
    const usage = entry.usage;
    if (!usage) return undefined;
    const parts = (
        [
            ['in', usage.inputTokens],
            ['out', usage.outputTokens],
            ['cache read', usage.cacheReadTokens],
            ['cache write', usage.cacheWriteTokens],
            ['reasoning', usage.reasoningTokens],
        ] as const
    )
        .filter(([, count]) => count !== undefined)
        .map(([label, count]) => `${label} ${count}`);
    return parts.length > 0 ? `  tokens: ${parts.join(' ')} (provider counters)` : undefined;
}

function entryBlock(entry: DelegationHistoryEntry, now: number): string {
    const model = entry.selection?.model ? `/${entry.selection.model}` : '';
    const failure = entry.failure ? ` (${entry.failure})` : '';
    const title = entry.title ? `  "${entry.title}"` : '';
    const lines = [
        `${entry.delegationId}  ${entry.outcome}${failure}  ${entry.provider}${model}  settled ${formatRelativeTime(entry.settledAt, now)}${title}`,
    ];
    if (entry.summary)
        lines.push(
            `  ${entry.summary}${entry.summarySource === 'excerpt' ? ' (excerpt of the answer)' : ''}`,
        );
    if (entry.compacted) lines.push('  (details compacted)');
    const tokens = tokensLine(entry);
    if (tokens) lines.push(tokens);
    return lines.join('\n');
}

/**
 * Human rendering of `agent.delegation.history`: one block per entry, then a paging hint. JSON mode never calls this.
 */
export function renderDelegationHistory(result: DelegationHistoryResult, now: number): string {
    if (result.entries.length === 0) return 'No delegated tasks match.\n';
    const blocks = result.entries.map((entry) => entryBlock(entry, now));
    const footer =
        result.hasMore && result.nextCursor ? `\nMore: --after ${result.nextCursor}` : '';
    return `${blocks.join('\n\n')}${footer}\n`;
}

export const DELEGATION_HISTORY_COMMANDS: RemoteCommandDefinition[] = [
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'history'],
        method: 'agent.delegation.history',
        quietKey: 'entries',
        quietIdKey: 'delegationId',
        summary:
            'Find your earlier delegated tasks by title or summary text, newest first, a page at a time.',
        usage: `[--query <text>] [--outcome <${outcomeUsage}>] [--limit <1-${MAX_DELEGATION_HISTORY_PAGE}>] [--after <cursor>]`,
        parseParams: historyParameters,
    },
];
