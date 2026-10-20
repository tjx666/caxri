import { rankPathMatches } from '@caxri/utils';

import type { SuggestionOption } from '../../../lib/suggestion-options';
import type { SessionReferenceCandidate } from '../../session/session-reference';
import { agentChatSessionSuggestion } from './agent-chat-suggestions';

/**
 * Most Project files the `@` list shows at once; the Sessions group below it keeps its own cap.
 */
export const MAX_AGENT_CHAT_FILE_MENTIONS = 8;

/**
 * Which group a row of the `@` list belongs to. Files come first, then Sessions. Completing workspace files from `@`
 * inside the Chat composer follows T3 Code's composer, which offers workspace paths on the same trigger.
 */
export type AgentChatMentionGroup = 'files' | 'sessions';

function basename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

function directoryOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * Orders Project-relative paths a name search found, best file-name match first (`rankPathMatches`, the ranking quick
 * open uses too), and keeps `limit` of them.
 */
export function rankAgentChatFileMentions(
    paths: readonly string[],
    query: string,
    limit: number = MAX_AGENT_CHAT_FILE_MENTIONS,
): string[] {
    return rankPathMatches(paths, (path) => path, query.trim(), limit);
}

/**
 * Project-relative paths of the files open in Editor tabs, for an empty `@` query: the files the user is working on are
 * the likeliest to be cited. Paths outside `root` (and virtual tabs, which have none) are left out; `open` is expected
 * most-recent first.
 */
export function openFileMentions(
    open: readonly string[],
    root: string | undefined,
    limit: number = MAX_AGENT_CHAT_FILE_MENTIONS,
): string[] {
    if (!root) return [];
    const prefix = root.endsWith('/') ? root : `${root}/`;
    const relative = open.flatMap((path) =>
        path.startsWith(prefix) && path.length > prefix.length ? [path.slice(prefix.length)] : [],
    );
    return [...new Set(relative)].slice(0, limit);
}

/**
 * One file row: the file name, with the directory it lives in beside it.
 */
export function agentChatFileSuggestion(relativePath: string): SuggestionOption {
    const directory = directoryOf(relativePath);
    return {
        key: `file-${relativePath}`,
        label: basename(relativePath),
        isLabelLiteral: false,
        ...(directory && { description: directory }),
    };
}

/**
 * What lands in the input for a chosen file: the `@` mention every Agent composer resolves, quoted when the path holds
 * whitespace, since an unquoted mention ends at the first space (the rule `formatSessionReference` follows).
 */
export function formatAgentChatFileMention(relativePath: string): string {
    return `@${/\s/u.test(relativePath) ? JSON.stringify(relativePath) : relativePath}`;
}

/**
 * The group heading a row of the merged `@` list starts, or `undefined` when it continues the group above it. Rows are
 * the `fileCount` files first, then the Sessions.
 */
export function agentChatMentionHeadingAt(
    fileCount: number,
    index: number,
): AgentChatMentionGroup | undefined {
    if (index === 0) return fileCount > 0 ? 'files' : 'sessions';
    return index === fileCount ? 'sessions' : undefined;
}

/**
 * One row of the merged `@` list: a Project file or a Session to cite.
 */
export type AgentChatMentionRow =
    { kind: 'file'; path: string } | { kind: 'session'; candidate: SessionReferenceCandidate };

/**
 * The merged list's rows in order: the files, then the Sessions.
 */
export function agentChatMentionRows(
    files: readonly string[],
    candidates: readonly SessionReferenceCandidate[],
): AgentChatMentionRow[] {
    return [
        ...files.map((path) => ({ kind: 'file' as const, path })),
        ...candidates.map((candidate) => ({ kind: 'session' as const, candidate })),
    ];
}

/**
 * How a row of the merged `@` list is drawn.
 */
export function agentChatMentionRowSuggestion(row: AgentChatMentionRow): SuggestionOption {
    return row.kind === 'file'
        ? agentChatFileSuggestion(row.path)
        : agentChatSessionSuggestion(row.candidate);
}

/**
 * The highlighted row for a list of `count` rows: the row the user moved to while the query is unchanged, else the
 * first, never past the last.
 */
export function agentChatMentionActiveIndex(
    active: { query: string | undefined; index: number },
    query: string | undefined,
    count: number,
): number {
    return active.query === query ? Math.min(active.index, count - 1) : 0;
}

/**
 * The row `delta` steps from `index` in a list of `count` rows, wrapping at both ends.
 */
export function agentChatMentionStep(index: number, delta: 1 | -1, count: number): number {
    return (index + delta + count) % count;
}
