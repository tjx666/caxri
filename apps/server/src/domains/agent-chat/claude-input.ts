import type { UUID } from 'node:crypto';

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentChatCommand, AgentChatImageInput, AgentChatItem } from '@caxri/protocol';
import {
    AGENT_CHAT_GOAL_COMMAND,
    MAX_AGENT_CHAT_COMMANDS,
    MAX_AGENT_CHAT_IMAGES,
    MAX_AGENT_CHAT_TEXT_LENGTH,
} from '@caxri/protocol';

import { clip, isRecord, stringField } from './chat-items';
import {
    isQueuedPromptUuid,
    isUsageLimitContinuePromptUuid,
    queuedPromptUuid,
    usageLimitContinuePromptUuid,
} from './queued-prompt-uuid';

const COMMAND_NAME = /^[\w:.-]{1,100}$/u;

/**
 * Translates Claude Code's slash commands (`initialize`'s `commands`, or a `commands_changed` push) into the Chat's
 * command list. `hidden` holds the commands Claude Code marks as bound to its own terminal UI (`/exit`, `/statusline`),
 * which do nothing useful outside it. A name listed twice keeps its first row, which is the one `/name` runs. Claude
 * Code's own `/goal` (`builtin`) carries the goal mark, so the composer's Goal mode drives it as it does Codex's; a
 * user's same-named skill does not.
 */
function claudeChatCommands(commands: unknown, hidden: ReadonlySet<string>): AgentChatCommand[] {
    if (!Array.isArray(commands)) return [];
    const seen = new Set<string>();
    const result: AgentChatCommand[] = [];
    for (const command of commands) {
        if (!isRecord(command)) continue;
        const name = stringField(command.name)?.replace(/^\//u, '');
        if (!name || !COMMAND_NAME.test(name) || seen.has(name) || hidden.has(name)) continue;
        seen.add(name);
        const description = stringField(command.description);
        const argumentHint = stringField(command.argumentHint);
        result.push({
            name,
            ...(description && { description: clip(description, 500) }),
            ...(argumentHint && { argumentHint: clip(argumentHint, 200) }),
            ...(command.builtin === true &&
                name === AGENT_CHAT_GOAL_COMMAND && { goal: true as const }),
        });
        if (result.length >= MAX_AGENT_CHAT_COMMANDS) break;
    }
    return result;
}

/**
 * Whether a prompt runs `/compact`. The Chat shows the compaction itself (its progress and the compacted notice), so
 * this command's own user message is never shown.
 */
export function isClaudeCompactCommand(text: string): boolean {
    return /^\/compact(?:\s|$)/u.test(text.trim());
}

/**
 * User message content for a prompt with images: the text first when there is any, then the images, as the Claude Code
 * TUI sends a pasted image. The text names each image where it belongs as `[Image #N]`, counting the images in order.
 */
function claudeUserContent(
    text: string,
    images: readonly AgentChatImageInput[],
): string | Array<Record<string, unknown>> {
    if (images.length === 0) return text;
    return [
        ...(text ? [{ type: 'text', text }] : []),
        ...images.map((image) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.data },
        })),
    ];
}

/**
 * How many images a user message's content carries, capped at what one Chat message may show.
 */
export function claudeUserImageCount(content: unknown): number {
    if (!Array.isArray(content)) return 0;
    const count = content.filter((block) => isRecord(block) && block.type === 'image').length;
    return Math.min(count, MAX_AGENT_CHAT_IMAGES);
}

/**
 * Claude Code's command list as the Chat offers it. Claude Code reports its commands at `initialize` and whenever they
 * change, and names the terminal-bound ones only on each turn's `init`, so both inputs are kept and re-combined, and
 * every change is published to the Chat's state.
 */
export class ClaudeCommandList {
    private reported: unknown;

    private readonly terminalBound = new Set<string>();

    constructor(private readonly publish: (commands: AgentChatCommand[]) => void) {}

    report(commands: unknown): void {
        this.reported = commands;
        this.publish(claudeChatCommands(commands, this.terminalBound));
    }

    /**
     * Records terminal-bound command names from an `init` message, publishing the filtered list when it changed.
     */
    hideTerminalBound(names: unknown): void {
        if (!Array.isArray(names)) return;
        const before = this.terminalBound.size;
        for (const name of names) if (typeof name === 'string') this.terminalBound.add(name);
        if (this.terminalBound.size === before) return;
        this.publish(claudeChatCommands(this.reported, this.terminalBound));
    }
}

/**
 * The uuid for a prompt; a `queued` one carries the queued marker (`queued-prompt-uuid.ts`). Claude Code keeps no
 * `priority` or other field on a transcript user record that could carry the delivery, so the uuid itself marks a
 * queued message across a resume and a Server Core restart (#1610). A steered message needs no mark: Claude Code
 * records one it folds into the running turn as a `queued_command` attachment instead of a user record. Verified with
 * Claude Code 2.1.296.
 */
export function claudePromptUuid(delivery?: 'queued' | 'steered'): UUID {
    return queuedPromptUuid(delivery) as UUID;
}

/**
 * Whether a transcript user record's uuid marks a message delivered from the follow-up queue.
 */
export function isQueuedClaudePrompt(uuid: string): boolean {
    return isQueuedPromptUuid(uuid);
}

/**
 * What a Claude Chat sends on its own once a used-up plan limit resets (issue #2220), instead of repeating the user's
 * last message. Hidden from the timeline live and on a history replay, where its uuid
 * ({@link claudeUsageLimitContinueUuid}) marks it, so the turn reads as the Agent continuing rather than the user
 * asking.
 */
export const CLAUDE_USAGE_LIMIT_CONTINUE_PROMPT =
    'Your usage limit has reset. Pick up where you left off and continue the work, without repeating steps that are already done.';

export function claudeUsageLimitContinueUuid(): UUID {
    return usageLimitContinuePromptUuid() as UUID;
}

/**
 * Whether a transcript user record's uuid marks an automatic continuation after a usage limit reset.
 */
export function isClaudeUsageLimitContinuePrompt(uuid: string): boolean {
    return isUsageLimitContinuePromptUuid(uuid);
}

/**
 * A prompt as the projection records it and as the SDK sends it. Claude Code does not echo the prompt back, so the
 * projection's user message is made here, with the Client's thumbnails rather than the images themselves.
 */
export function claudeUserPrompt(prompt: {
    uuid: UUID;
    turnId: string;
    sessionId: string;
    text: string;
    images: readonly AgentChatImageInput[];
    /**
     * How the message reached the Agent when it did not simply start a turn; recorded on the user message.
     */
    delivery?: 'queued' | 'steered';
    /**
     * `next` folds a steered message into the running turn at its next model request, instead of after the turn.
     */
    priority?: 'next';
}): { item: AgentChatItem; message: SDKUserMessage } {
    const { uuid, turnId, sessionId, text, images, delivery, priority } = prompt;
    return {
        item: {
            id: uuid,
            turnId,
            type: 'userMessage',
            text: clip(text, MAX_AGENT_CHAT_TEXT_LENGTH),
            ...(images.length > 0 && {
                images: images.map((image) => ({ thumbnail: image.thumbnail })),
            }),
            ...(delivery && { delivery }),
        },
        message: {
            type: 'user',
            message: {
                role: 'user',
                content: claudeUserContent(text, images) as SDKUserMessage['message']['content'],
            },
            parent_tool_use_id: null,
            uuid,
            session_id: sessionId,
            ...(priority && { priority }),
        },
    };
}
