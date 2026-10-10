import type { AgentChatCommand, AgentChatItem, AgentChatMessageInput } from '@caxri/protocol';

import { isRecord, stringField } from './chat-items';
import type { JsonRpcRequestError } from './json-rpc-connection';

/**
 * Slash commands Caxri maps to app-server methods. The Codex TUI's other commands drive its own screen (`/model`
 * pickers, `/status` panels) and have no app-server equivalent, so they are not offered.
 */
export const CODEX_COMMANDS: AgentChatCommand[] = [
    { name: 'compact', description: 'Summarize the conversation to free up context' },
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
 * Sent messages whose Codex echo has not arrived yet, kept only to mark how they were delivered.
 */
const MAX_PENDING_DELIVERIES = 20;

/**
 * How each sent message reached Codex (`steered` into the running turn or `queued` by Server Core), keyed by the
 * `clientUserMessageId` its user message item echoes back as `clientId`.
 */
export class CodexDeliveries {
    private readonly pending = new Map<string, 'queued' | 'steered'>();

    remember(clientUserMessageId: string, delivery: 'queued' | 'steered'): void {
        this.pending.set(clientUserMessageId, delivery);
        for (const key of this.pending.keys()) {
            if (this.pending.size <= MAX_PENDING_DELIVERIES) break;
            this.pending.delete(key);
        }
    }

    /**
     * Drops the marker of a message that was not delivered the way it was sent, such as a steer that started a turn.
     */
    forget(clientUserMessageId: string): void {
        this.pending.delete(clientUserMessageId);
    }

    apply(item: AgentChatItem, raw: unknown): AgentChatItem {
        if (item.type !== 'userMessage' || !isRecord(raw)) return item;
        const clientId = stringField(raw.clientId);
        const delivery = clientId ? this.pending.get(clientId) : undefined;
        return delivery ? { ...item, delivery } : item;
    }
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
