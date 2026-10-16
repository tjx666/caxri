import { randomUUID } from 'node:crypto';

import { MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

import { clip, stringField } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';

/**
 * Claude Code `system` frames that show as Chat state or notices rather than conversation content: compaction progress
 * and its result, and API retries. Inputs are untrusted JSON.
 */

type Json = Record<string, unknown>;

type NoticeHost = Pick<AgentChatSessionHost, 'apply' | 'lifecycle' | 'read'>;

/**
 * Claude Code emits hook feedback as informational banners, hook lifecycle output, or local command output. Keep
 * text-bearing system frames in delivery order; lifecycle frames without text remain silent. Notices are split at the
 * protocol's text bound rather than silently dropping the tail of a hook's output.
 *
 * @see https://platform.claude.com/docs/en/agent-sdk/typescript#sdkmessage
 */
export function onClaudeTranscriptOutput(host: NoticeHost, message: Json): void {
    const content =
        [
            stringField(message.content),
            stringField(message.output),
            [stringField(message.stdout), stringField(message.stderr)].filter(Boolean).join('\n'),
        ].find((text) => text?.trim()) ?? '';
    if (!content.trim()) return;
    const id = clip(`claude-output:${stringField(message.uuid) ?? randomUUID()}`, 180);
    const turnId = host.read().activeTurnId;
    const isMessage = message.subtype === 'local_command_output';
    const limit = isMessage ? MAX_AGENT_CHAT_TEXT_LENGTH : 2_000;
    for (let offset = 0; offset < content.length; offset += limit) {
        const identity = { id: `${id}:${offset}`, ...(turnId && { turnId }) };
        const text = content.slice(offset, offset + limit);
        host.apply([
            {
                op: 'upsertItem',
                item: isMessage
                    ? { ...identity, type: 'agentMessage', text, streaming: false }
                    : {
                          ...identity,
                          type: 'notice',
                          kind: message.outcome === 'error' ? 'error' : 'output',
                          message: text,
                      },
            },
        ]);
    }
}

function didClearCompacting(host: NoticeHost): boolean {
    if (host.read().operation !== 'compacting') return false;
    host.apply([{ op: 'state', state: { operation: null } }]);
    return true;
}

/**
 * `system/status`: `compacting` while Claude Code summarizes the conversation, then back to `null` (or `requesting`)
 * with the compaction's result. A failed compaction leaves an error notice, since no `compact_boundary` follows it.
 */
export function onClaudeStatus(host: NoticeHost, message: Json): void {
    if (message.status === 'compacting') {
        if (host.read().operation === 'compacting') return;
        host.apply([{ op: 'state', state: { operation: 'compacting' } }]);
        host.lifecycle({ phase: 'compactionStarted' });
        return;
    }
    const wasCompacting = didClearCompacting(host);
    const error = stringField(message.compact_error);
    if (!error && message.compact_result !== 'failed') return;
    const turnId = host.read().activeTurnId;
    host.apply([
        {
            op: 'upsertItem',
            item: {
                id: clip(`compact-error:${stringField(message.uuid) ?? randomUUID()}`, 200),
                ...(turnId && { turnId }),
                type: 'notice',
                kind: 'error',
                message: clip(error ?? 'Claude could not compact the conversation', 2_000),
            },
        },
    ]);
    if (wasCompacting) host.lifecycle({ phase: 'compactionFinished' });
}

/**
 * `system/compact_boundary`: the conversation was compacted. Its notice also stands for the `/compact` command, whose
 * own user message the Chat never shows.
 */
export function onClaudeCompactBoundary(host: NoticeHost, message: Json): void {
    didClearCompacting(host);
    const turnId = host.read().activeTurnId;
    const id = clip(`compact:${stringField(message.uuid) ?? randomUUID()}`, 200);
    host.apply([
        {
            op: 'upsertItem',
            item: { id, ...(turnId && { turnId }), type: 'notice', kind: 'compacted' },
        },
    ]);
    host.lifecycle({ phase: 'compactionFinished' });
}

/**
 * `system/api_retry`: one notice per turn, updated with the latest attempt.
 */
export function onClaudeApiRetry(host: NoticeHost, message: Json): void {
    const turnId = host.read().activeTurnId;
    if (!turnId) return;
    const attempt = typeof message.attempt === 'number' ? message.attempt : undefined;
    host.apply([
        {
            op: 'upsertItem',
            item: {
                id: clip(`${turnId}:retry`, 200),
                turnId,
                type: 'notice',
                kind: 'retrying',
                ...(attempt !== undefined && { message: `Attempt ${attempt}` }),
            },
        },
    ]);
}
