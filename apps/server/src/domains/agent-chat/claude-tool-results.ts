import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentChatItem, AgentChatPatchOperation } from '@caxri/protocol';
import { MAX_AGENT_CHAT_DIFF_LENGTH, MAX_AGENT_CHAT_OUTPUT_LENGTH } from '@caxri/protocol';
import { omit } from 'es-toolkit';

import { clip, isRecord, stringField, tail } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';
import { structuredPatchDiff, text } from './claude-items';

/**
 * Settles Claude Code tool calls from their `tool_result` blocks, in the live stream and the session transcript alike:
 * status, output, the real patch of a file edit, and a command's exit code, duration, and background hand-off.
 */

type Json = Record<string, unknown>;

function toolResultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .flatMap((part) => (isRecord(part) && part.type === 'text' ? [text(part.text)] : []))
        .join('\n');
}

/**
 * What Caxri knows about a `tool_result` beyond the block itself.
 */
export interface ClaudeToolResult {
    /**
     * Claude Code's structured tool output (`tool_use_result` in the SDK, `toolUseResult` in the transcript), which
     * carries the real patch for file edits and the background hand-off for `Bash`.
     */
    structured?: unknown;
    /**
     * The user declined the tool, which Claude Code reports as an error result.
     */
    wasDeclined?: boolean;
    /**
     * Time from the `tool_use` to its result as Caxri saw them. Claude Code reports no duration of its own.
     */
    durationMs?: number;
}

/**
 * The message Caxri denies a declined tool call with. Claude Code returns it as the call's error result and records it
 * in the transcript, which is the only trace of the decline once the live session that saw the user's answer is gone.
 */
export const CLAUDE_DECLINED_MESSAGE = 'The user declined this action.';

/**
 * Whether a tool call ended declined: the live session saw the user decline it, or, rebuilding the Chat from its
 * transcript, the result is Caxri's decline message. Without the second check a Chat reopened after Server Core
 * restarted would show the same declined call as failed.
 */
const isDeclinedResult = (block: Json, output: string, wasDeclined: boolean | undefined) =>
    wasDeclined === true || (block.is_error === true && output.trim() === CLAUDE_DECLINED_MESSAGE);

/**
 * Claude Code reports a failed `Bash` as an error result whose text starts with `Exit code N`; a successful one has no
 * code, because only a zero exit is not an error.
 */
const EXIT_CODE_PREFIX = /^Exit code (\d{1,3})\b/u;

/**
 * Settles a `Bash` item: a command Claude Code handed to the background is reported as such instead of as finished,
 * since its exit code and duration belong to a later notification Caxri does not track.
 */
function settleClaudeCommand(
    item: Extract<AgentChatItem, { type: 'command' }>,
    block: Json,
    { structured, durationMs }: ClaudeToolResult,
    status: 'completed' | 'declined' | 'failed',
    output: string,
): AgentChatItem {
    const result = isRecord(structured) ? structured : {};
    const isBackground =
        item.background === true ||
        stringField(result.backgroundTaskId) !== undefined ||
        result.backgroundedByUser === true;
    if (isBackground) return { ...item, background: true, status, output };
    const exitCode =
        block.is_error === true
            ? EXIT_CODE_PREFIX.exec(output)?.[1]
            : status === 'completed'
              ? '0'
              : undefined;
    return {
        ...item,
        status: result.interrupted === true ? 'interrupted' : status,
        output,
        ...(exitCode !== undefined && { exitCode: Number(exitCode) }),
        ...(durationMs !== undefined && { durationMs }),
    };
}

type FileChange = Extract<AgentChatItem, { type: 'fileChange' }>['changes'][number];

/**
 * A change carrying the real patch in place of the diff guessed from the tool input. `truncated` follows the patch, so
 * Undo refuses a change whose diff was cut instead of reversing only part of it.
 */
function settledDiff(change: FileChange, patch: string): FileChange {
    const diff = clip(patch, MAX_AGENT_CHAT_DIFF_LENGTH);
    return {
        ...omit(change, ['truncated']),
        diff,
        ...(diff.length < patch.length && { truncated: true }),
    };
}

/**
 * Settles the item a `tool_result` block answers.
 */
export function settleClaudeToolItem(
    item: AgentChatItem,
    block: Json,
    result: ClaudeToolResult = {},
): AgentChatItem | undefined {
    const isError = block.is_error === true;
    const output = tail(toolResultText(block.content), MAX_AGENT_CHAT_OUTPUT_LENGTH);
    const status = isDeclinedResult(block, output, result.wasDeclined)
        ? 'declined'
        : isError
          ? 'failed'
          : 'completed';
    const { durationMs } = result;
    switch (item.type) {
        case 'command': {
            return settleClaudeCommand(item, block, result, status, output);
        }
        case 'toolCall': {
            return {
                ...item,
                status,
                ...(output && { output }),
                ...(durationMs !== undefined && { durationMs }),
            };
        }
        case 'fileChange': {
            const structured = isRecord(result.structured) ? result.structured : {};
            const patch = structuredPatchDiff(structured.structuredPatch);
            return {
                ...item,
                status,
                changes: item.changes.map((change, index) =>
                    index === 0
                        ? {
                              ...(patch ? settledDiff(change, patch) : change),
                              ...(structured.type === 'create' && { kind: 'add' as const }),
                          }
                        : change,
                ),
            };
        }
        default: {
            return undefined;
        }
    }
}

/**
 * When each tool call started, as Caxri saw its `tool_use` arrive, so its result can carry a duration. Claude Code
 * reports none; the gap also counts any wait on an approval, as the Codex app's own durations do.
 */
export class ClaudeToolClock {
    private readonly startedAt = new Map<string, number>();

    start(items: readonly AgentChatItem[]): void {
        for (const item of items)
            if (
                (item.type === 'command' || item.type === 'toolCall') &&
                !this.startedAt.has(item.id)
            )
                this.startedAt.set(item.id, Date.now());
    }

    stop(id: string): number | undefined {
        const startedAt = this.startedAt.get(id);
        this.startedAt.delete(id);
        return startedAt === undefined ? undefined : Math.max(0, Date.now() - startedAt);
    }

    /**
     * Forgets calls a finished turn left without a result, such as an interrupted one.
     */
    clear(): void {
        this.startedAt.clear();
    }
}

/**
 * Settles every item a user message's `tool_result` blocks answer, and returns those content blocks for the subagent
 * tasks to read. `resolve` supplies what only the live session knows about each result: whether the user declined it,
 * and how long it ran.
 */
export function applyClaudeToolResults(
    host: Pick<AgentChatSessionHost, 'apply' | 'read'>,
    message: SDKUserMessage,
    resolve: (id: string) => Omit<ClaudeToolResult, 'structured'>,
): unknown[] | undefined {
    const content: unknown = isRecord(message.message) ? message.message.content : undefined;
    if (!Array.isArray(content)) return undefined;
    const blocks: unknown[] = content;
    const byId = new Map(host.read().items.map((item) => [item.id, item]));
    const structured = message.tool_use_result;
    const operations = blocks.flatMap((block: unknown): AgentChatPatchOperation[] => {
        if (!isRecord(block) || block.type !== 'tool_result') return [];
        const toolUseId = stringField(block.tool_use_id);
        if (!toolUseId) return [];
        const id = clip(toolUseId, 200);
        const item = byId.get(id);
        const settled = item && settleClaudeToolItem(item, block, { structured, ...resolve(id) });
        return settled ? [{ op: 'upsertItem', item: settled }] : [];
    });
    if (operations.length > 0) host.apply(operations);
    return blocks;
}
