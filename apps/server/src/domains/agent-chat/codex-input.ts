import { randomUUID } from 'node:crypto';

import type {
    AgentChatCommand,
    AgentChatImageInput,
    AgentChatItem,
    AgentChatMessageInput,
} from '@caxri/protocol';
import { AGENT_CHAT_GOAL_COMMAND } from '@caxri/protocol';

import { isRecord, storedChatImageSchema, stringField } from './chat-items';
import type { JsonRpcRequestError } from './json-rpc-connection';

/**
 * Slash commands Caxri maps to app-server methods: `/compact` (`thread/compact/start`), `/goal` (`thread/goal/*`), and
 * `/review` (`review/start`). The Codex TUI's other commands drive its own screen (`/model` pickers, `/status` panels)
 * and have no app-server equivalent, so they are not offered.
 */
export const CODEX_COMMANDS: AgentChatCommand[] = [
    { name: 'compact', description: 'Summarize the conversation to free up context' },
    {
        name: 'review',
        description: 'Review code changes for bugs and risks',
        argumentHint: '[--base <branch> | --commit <sha> | instructions]',
    },
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
export function codexClientMessageId(delivery?: 'queued' | 'steered' | 'notice'): string {
    return delivery ? `${delivery}:${randomUUID()}` : randomUUID();
}

/**
 * Whether a user message is a notice Caxri itself steered into the turn ({@link codexClientMessageId} `notice`), such as
 * telling the Agent a subagent was stopped. The timeline shows it as a notice rather than as something the user said.
 */
export function isCodexNotice(raw: Record<string, unknown>): boolean {
    return (stringField(raw.clientId) ?? '').startsWith('notice:');
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

/**
 * Whether a rejected `turn/steer` means the running turn takes no steered input (a review or compaction turn), so the
 * message should wait for that turn to end instead.
 *
 * @see https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/turn_processor.rs
 */
export function isSteerTargetNotSteerable(error: JsonRpcRequestError): boolean {
    return /^cannot steer a (?:review|compact) turn/u.test(error.message);
}

/**
 * User inputs that are references rather than text; the Chat shows their name in brackets.
 */
const REFERENCE_INPUT_TYPES = new Set<unknown>(['mention', 'skill']);

const IMAGE_INPUT_TYPES = new Set<unknown>(['image', 'localImage']);

/**
 * How many images a user message carried. Codex echoes the full image (a data URL or a local path), which is never
 * copied into the projection; the session pairs a message it sent with the thumbnails the Client made.
 */
export function codexUserImageCount(content: unknown): number {
    if (!Array.isArray(content)) return 0;
    return content.filter((input) => isRecord(input) && IMAGE_INPUT_TYPES.has(input.type)).length;
}

/**
 * A user message's text as the Chat shows it, with references (mentions, skills) as their name in brackets.
 */
export function userMessageText(content: unknown): string {
    if (!Array.isArray(content)) return '';
    return content
        .flatMap((input) => {
            if (!isRecord(input)) return [];
            if (input.type === 'text') return [stringField(input.text) ?? ''];
            if (REFERENCE_INPUT_TYPES.has(input.type))
                return [`[${stringField(input.name) ?? stringField(input.path) ?? ''}]`];
            return [];
        })
        .join('\n');
}

/**
 * Image entries of a rollout's user message, in the order the app-server's `image` and `localImage` inputs count them
 * (`codexUserImageCount`), so a placeholder's position names the same image in both.
 */
const ROLLOUT_IMAGE_TYPES = new Set<unknown>(['image', 'local_image']);

const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.+)$/su;

function parseRecord(line: string): Record<string, unknown> | undefined {
    try {
        const record: unknown = JSON.parse(line);
        return isRecord(record) ? record : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The content of the user message `itemId` names, from the `item_completed` event Codex writes to the rollout for each
 * one. Its `id` is the item id the app-server reports, live and on `thread/resume`, so a resumed placeholder finds its
 * record. Verified with codex-cli 0.164.0-alpha.8.
 */
function userMessageContent(
    record: Record<string, unknown>,
    itemId: string,
): unknown[] | undefined {
    const payload = isRecord(record.payload) ? record.payload : undefined;
    const item = isRecord(payload?.item) ? payload.item : undefined;
    if (
        record.type !== 'event_msg' ||
        payload?.type !== 'item_completed' ||
        item?.type !== 'UserMessage' ||
        stringField(item.id) !== itemId
    )
        return undefined;
    const content: unknown = item.content;
    return Array.isArray(content) ? (content as unknown[]) : [];
}

/**
 * The `index`th image of the user message `itemId` names, as the Codex rollout stores it; `undefined` when the rollout
 * holds no such message, and `null` when the message has no readable image there. A `local_image` is never read: its
 * path is wherever the sender's file was, not one a Session authorized, so it only keeps its position. Only a line
 * naming the id is parsed, so finding one message does not decode every image in the rollout.
 */
export function codexHistoryImage(
    rollout: string,
    itemId: string,
    index: number,
): Omit<AgentChatImageInput, 'thumbnail'> | null | undefined {
    for (const line of rollout.split('\n')) {
        if (!line.includes(itemId)) continue;
        const record = parseRecord(line);
        const content = record && userMessageContent(record, itemId);
        if (!content) continue;
        const image: unknown = content.filter(
            (entry) => isRecord(entry) && ROLLOUT_IMAGE_TYPES.has(entry.type),
        )[index];
        const url =
            isRecord(image) && image.type === 'image' ? stringField(image.image_url) : undefined;
        const match = url ? DATA_URL_PATTERN.exec(url) : null;
        if (!match) return null;
        const parsed = storedChatImageSchema.safeParse({ mediaType: match[1], data: match[2] });
        return parsed.success ? parsed.data : null;
    }
    return undefined;
}
