import { randomUUID } from 'node:crypto';

import type { AgentChatCommand, AgentChatItem, AgentChatMessageInput } from '@caxri/protocol';
import { AGENT_CHAT_GOAL_COMMAND } from '@caxri/protocol';

import { isRecord, stringField } from './chat-items';
import type { JsonRpcRequestError } from './json-rpc-connection';

/**
 * Slash commands Caxri maps to app-server methods. The Codex TUI's other commands drive its own screen (`/model`
 * pickers, `/status` panels) and have no app-server equivalent, so they are not offered.
 */
export const CODEX_COMMANDS: AgentChatCommand[] = [
    { name: 'compact', description: 'Summarize the conversation to free up context' },
    {
        name: AGENT_CHAT_GOAL_COMMAND,
        description: 'Set a goal the Agent keeps working toward',
        argumentHint: '<objective> | pause | resume | clear',
        goal: true,
    },
];

/**
 * Sent messages whose Codex echo has not arrived yet, kept only to pair thumbnails with it.
 */
const MAX_PENDING_THUMBNAILS = 20;

/**
 * `UserInput` entries for `turn/start` and `turn/steer`: images as data URLs first, as the Codex TUI sends a pasted
 * image, then the text when there is any.
 */
export function codexUserInput({ text, images = [] }: AgentChatMessageInput): unknown[] {
    return [
        ...images.map((image) => ({
            type: 'image',
            url: `data:${image.mediaType};base64,${image.data}`,
        })),
        ...(text ? [{ type: 'text', text, text_elements: [] }] : []),
    ];
}

/**
 * Thumbnails of sent messages with images, keyed by the `clientUserMessageId` Codex echoes back as the user message
 * item's `clientId`. Codex echoes the full image, which never enters the projection, so the item only says how many
 * images there were until it is paired here.
 */
export class CodexThumbnails {
    private readonly pending = new Map<string, string[]>();

    remember(clientUserMessageId: string, { images = [] }: AgentChatMessageInput): void {
        if (images.length === 0) return;
        this.pending.set(
            clientUserMessageId,
            images.map((image) => image.thumbnail),
        );
        for (const key of this.pending.keys()) {
            if (this.pending.size <= MAX_PENDING_THUMBNAILS) break;
            this.pending.delete(key);
        }
    }

    apply(item: AgentChatItem, raw: unknown): AgentChatItem {
        if (item.type !== 'userMessage' || !item.images || !isRecord(raw)) return item;
        const clientId = stringField(raw.clientId);
        const thumbnails = clientId ? this.pending.get(clientId) : undefined;
        if (!thumbnails) return item;
        return {
            ...item,
            images: item.images.map((image, index) =>
                thumbnails[index] ? { thumbnail: thumbnails[index] } : image,
            ),
        };
    }
}

/**
 * The `clientUserMessageId` for a sent message. A message Server Core delivered as `queued` or `steered` carries its
 * delivery as a prefix (`queued:<uuid>`), which Codex echoes back as the user message's `clientId` and keeps in the
 * thread's rollout, so the marker survives a resume and a Server Core restart (#1610). Verified with codex-cli
 * 0.163.0-alpha.5 for `turn/start`, `turn/steer`, and `thread/resume`.
 */
export function codexClientMessageId(delivery?: 'queued' | 'steered'): string {
    return delivery ? `${delivery}:${randomUUID()}` : randomUUID();
}

/**
 * The delivery a user message's echoed `clientId` records; see {@link codexClientMessageId}.
 */
export function codexDelivery(raw: Record<string, unknown>): 'queued' | 'steered' | undefined {
    const clientId = stringField(raw.clientId) ?? '';
    if (clientId.startsWith('queued:')) return 'queued';
    if (clientId.startsWith('steered:')) return 'steered';
    return undefined;
}

/**
 * Whether a rejected `turn/steer` means the turn it targeted already ended, so the message should start the next turn.
 * App-server answers `no active turn to steer` or `expected active turn id ... but found ...`; a turn that cannot be
 * steered (review, compaction) or a malformed input is a real failure.
 *
 * @see https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/turn_processor.rs
 */
export function isSteerTargetGone(error: JsonRpcRequestError): boolean {
    return /^(?:no active turn to steer|expected active turn id)/u.test(error.message);
}
