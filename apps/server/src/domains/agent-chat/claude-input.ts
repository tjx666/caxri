import type { UUID } from 'node:crypto';

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentChatCommand, AgentChatImageInput, AgentChatItem } from '@caxri/protocol';
import {
    MAX_AGENT_CHAT_COMMANDS,
    MAX_AGENT_CHAT_IMAGES,
    MAX_AGENT_CHAT_TEXT_LENGTH,
} from '@caxri/protocol';

import { clip, isRecord, stringField } from './chat-items';

const COMMAND_NAME = /^[\w:.-]{1,100}$/u;

/**
 * Translates Claude Code's slash commands (`initialize`'s `commands`, or a `commands_changed` push) into the Chat's
 * command list. `hidden` holds the commands Claude Code marks as bound to its own terminal UI (`/exit`, `/statusline`),
 * which do nothing useful outside it. A name listed twice keeps its first row, which is the one `/name` runs.
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
 * User message content for a prompt with images: the images first, as the Claude Code TUI sends a pasted image, then
 * the text when there is any.
 */
function claudeUserContent(
    text: string,
    images: readonly AgentChatImageInput[],
): string | Array<Record<string, unknown>> {
    if (images.length === 0) return text;
    return [
        ...images.map((image) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.data },
        })),
        ...(text ? [{ type: 'text', text }] : []),
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
 * change, and names the terminal-bound ones only on each turn's `init`, so both inputs are kept and re-combined.
 */
export class ClaudeCommandList {
    private reported: unknown;

    private readonly terminalBound = new Set<string>();

    report(commands: unknown): AgentChatCommand[] {
        this.reported = commands;
        return claudeChatCommands(commands, this.terminalBound);
    }

    /**
     * Records terminal-bound command names from an `init` message. Returns the filtered list when it changed.
     */
    hideTerminalBound(names: unknown): AgentChatCommand[] | undefined {
        if (!Array.isArray(names)) return undefined;
        const before = this.terminalBound.size;
        for (const name of names) if (typeof name === 'string') this.terminalBound.add(name);
        if (this.terminalBound.size === before) return undefined;
        return claudeChatCommands(this.reported, this.terminalBound);
    }
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
