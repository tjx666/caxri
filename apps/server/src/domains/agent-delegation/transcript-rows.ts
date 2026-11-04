import type { AgentChatItem, DelegationTranscriptRow } from '@caxri/protocol';
import {
    MAX_DELEGATION_TRANSCRIPT_PATHS,
    MAX_DELEGATION_TRANSCRIPT_ROW_TEXT,
} from '@caxri/protocol';

interface Clipped {
    text: string;
    isClipped: boolean;
}

/**
 * Keeps at most `MAX_DELEGATION_TRANSCRIPT_ROW_TEXT` characters (code points, so a surrogate pair is never split): the
 * head of prose, the tail of command output, where the result of a run is.
 */
function clip(text: string, keep: 'head' | 'tail'): Clipped {
    if (text.length <= MAX_DELEGATION_TRANSCRIPT_ROW_TEXT) return { text, isClipped: false };
    const characters = Array.from(text);
    if (characters.length <= MAX_DELEGATION_TRANSCRIPT_ROW_TEXT) return { text, isClipped: false };
    const kept =
        keep === 'head'
            ? characters.slice(0, MAX_DELEGATION_TRANSCRIPT_ROW_TEXT)
            : characters.slice(-MAX_DELEGATION_TRANSCRIPT_ROW_TEXT);
    return { text: kept.join(''), isClipped: true };
}

function truncated(...fields: Clipped[]): { truncated?: true } {
    return fields.some((field) => field.isClipped) ? { truncated: true } : {};
}

/**
 * The transcript row of one Chat item of a delegated task, or `undefined` for an item the delegating Agent has no use
 * for. `userMessage` items never reach this: the reader ends the task's conversation at the first one after its start.
 */
export function delegationTranscriptRow(item: AgentChatItem): DelegationTranscriptRow | undefined {
    switch (item.type) {
        case 'agentMessage': {
            const text = clip(item.text, 'head');
            return {
                id: item.id,
                kind: 'agentMessage',
                text: text.text,
                ...(item.streaming && { streaming: true }),
                ...truncated(text),
            };
        }
        case 'reasoning': {
            const text = clip(item.text, 'head');
            return {
                id: item.id,
                kind: 'reasoning',
                text: text.text,
                ...(item.streaming && { streaming: true }),
                ...truncated(text),
            };
        }
        case 'command': {
            const command = clip(item.command, 'head');
            const output = clip(item.output, 'tail');
            return {
                id: item.id,
                kind: 'command',
                command: command.text,
                status: item.status,
                ...(item.exitCode !== undefined && { exitCode: item.exitCode }),
                output: output.text,
                ...truncated(command, output),
            };
        }
        case 'fileChange':
            return {
                id: item.id,
                kind: 'fileChange',
                status: item.status,
                paths: item.changes
                    .slice(0, MAX_DELEGATION_TRANSCRIPT_PATHS)
                    .map((change) => ({ path: change.path, change: change.kind })),
                ...(item.changes.length > MAX_DELEGATION_TRANSCRIPT_PATHS && { truncated: true }),
            };
        case 'toolCall':
            return {
                id: item.id,
                kind: 'toolCall',
                name: item.name,
                status: item.status,
                ...(item.summary !== undefined && { summary: item.summary }),
            };
        case 'notice':
            return {
                id: item.id,
                kind: 'notice',
                notice: item.kind,
                ...(item.message !== undefined && { message: item.message }),
            };
        default:
            return undefined;
    }
}

/**
 * Whether a row can no longer change: its text is fully written and its step has finished. A later read must return a
 * row that can still change, so a page never resumes after one.
 */
export function isDelegationTranscriptRowFinished(row: DelegationTranscriptRow): boolean {
    switch (row.kind) {
        case 'agentMessage':
        case 'reasoning':
            return !row.streaming;
        case 'command':
        case 'fileChange':
        case 'toolCall':
            return row.status !== 'running';
        case 'notice':
        case 'task':
            return true;
    }
}

/**
 * The characters of text a row carries, which the page budget counts.
 */
export function delegationTranscriptRowLength(row: DelegationTranscriptRow): number {
    switch (row.kind) {
        case 'agentMessage':
        case 'reasoning':
            return row.text.length;
        case 'command':
            return row.command.length + row.output.length;
        case 'fileChange':
            return row.paths.reduce((total, entry) => total + entry.path.length, 0);
        case 'toolCall':
            return row.name.length + (row.summary?.length ?? 0);
        case 'notice':
            return row.message?.length ?? 0;
        case 'task':
            return 0;
    }
}
