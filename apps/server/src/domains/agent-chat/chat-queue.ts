import type {
    AgentChatMessageInput,
    AgentChatPatchOperation,
    AgentChatQueuedMessage,
    AgentChatSnapshot,
} from '@caxri/protocol';
import {
    CaxriError,
    MAX_AGENT_CHAT_IMAGES,
    MAX_AGENT_CHAT_IMAGES_TOTAL_BASE64_LENGTH,
    MAX_AGENT_CHAT_MESSAGE_LENGTH,
    MAX_AGENT_CHAT_QUEUE,
    MAX_AGENT_CHAT_QUEUE_TEXT_LENGTH,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import { clip } from './chat-items';
import type { AgentChatProviderSession, ChatInputDelivery } from './chat-provider';
import { isDeliveryUnknown } from './chat-provider';

/**
 * A follow-up held by Server Core until the running turn ends. Image data stays here; Clients see
 * {@link AgentChatQueuedMessage}.
 */
export type QueuedInput =
    | { id: string; kind: 'message'; message: Omit<AgentChatMessageInput, 'delivery'> }
    | { id: string; kind: 'command'; name: string; arguments?: string };

/**
 * Closed reasons for the `agent_chat.queue_changed` log.
 */
type QueueChange =
    | 'deliveryUnknown'
    | 'dispatched'
    | 'dispatchFailed'
    | 'paused'
    | 'queued'
    | 'removed'
    | 'resumed'
    | 'sentNow'
    | 'steered';

function textLength(input: QueuedInput): number {
    return input.kind === 'message'
        ? input.message.text.length
        : input.name.length + (input.arguments?.length ?? 0);
}

/**
 * Rejects an input that would push the queue past its count or text bound.
 */
function assertQueueRoom(queue: readonly QueuedInput[], entry: QueuedInput): void {
    if (queue.length >= MAX_AGENT_CHAT_QUEUE)
        throw new CaxriError('VALIDATION', 'Too many messages are queued');
    const total = queue.reduce((sum, input) => sum + textLength(input), textLength(entry));
    if (total > MAX_AGENT_CHAT_QUEUE_TEXT_LENGTH)
        throw new CaxriError('VALIDATION', 'Queued messages are too long');
}

/**
 * What Clients see of the queue: text and an image count, never image data.
 */
function queueView(queue: readonly QueuedInput[]): AgentChatQueuedMessage[] {
    return queue.map((entry) =>
        entry.kind === 'message'
            ? {
                  id: entry.id,
                  text: entry.message.text,
                  ...(entry.message.images?.length && { imageCount: entry.message.images.length }),
              }
            : {
                  id: entry.id,
                  text: clip(
                      `/${entry.name}${entry.arguments ? ` ${entry.arguments}` : ''}`,
                      MAX_AGENT_CHAT_MESSAGE_LENGTH,
                  ),
                  command: {
                      name: entry.name,
                      ...(entry.arguments !== undefined && { arguments: entry.arguments }),
                  },
              },
    );
}

type QueuedMessage = Extract<QueuedInput, { kind: 'message' }>;

/**
 * Separates the messages one dispatch joins, so each still reads as its own paragraph.
 */
const MERGED_MESSAGE_SEPARATOR = '\n\n';

/**
 * The entries the next dispatch sends as one input: the run of messages at the head of the queue, as far as one message
 * may carry (text length, image count, combined image size), or the command at the head on its own. Messages the user
 * queued back to back answer the same turn, so they go out together instead of one turn each; a command cannot join a
 * message and keeps its own turn.
 */
function dispatchBatch(entries: readonly QueuedInput[]): QueuedInput[] {
    const [first] = entries;
    if (first.kind === 'command') return [first];
    const batch: QueuedMessage[] = [first];
    let textLength = first.message.text.length;
    let imageCount = first.message.images?.length ?? 0;
    let imageLength = first.message.images?.reduce((sum, image) => sum + image.data.length, 0) ?? 0;
    for (const entry of entries.slice(1)) {
        if (entry.kind !== 'message') break;
        const images = entry.message.images ?? [];
        const nextTextLength =
            textLength + MERGED_MESSAGE_SEPARATOR.length + entry.message.text.length;
        const nextImageCount = imageCount + images.length;
        const nextImageLength = images.reduce((sum, image) => sum + image.data.length, imageLength);
        if (
            nextTextLength > MAX_AGENT_CHAT_MESSAGE_LENGTH ||
            nextImageCount > MAX_AGENT_CHAT_IMAGES ||
            nextImageLength > MAX_AGENT_CHAT_IMAGES_TOTAL_BASE64_LENGTH
        )
            break;
        batch.push(entry);
        textLength = nextTextLength;
        imageCount = nextImageCount;
        imageLength = nextImageLength;
    }
    return batch;
}

/**
 * The one input a batch sends: a command as it is, or its messages joined in queue order with every image attached. An
 * image-only message adds no blank paragraph.
 */
function mergeBatch(batch: readonly QueuedInput[]): QueuedInput {
    const [first] = batch;
    if (batch.length === 1) return first;
    const messages = batch as readonly QueuedMessage[];
    const images = messages.flatMap((entry) => entry.message.images ?? []);
    return {
        id: first.id,
        kind: 'message',
        message: {
            text: messages
                .map((entry) => entry.message.text)
                .filter((text) => text.length > 0)
                .join(MERGED_MESSAGE_SEPARATOR),
            ...(images.length > 0 && { images }),
        },
    };
}

/**
 * What the queue needs from its Chat. `enqueue` is the Chat's serialized input chain, so a dispatched input stays in
 * order with inputs the user sends directly.
 */
export interface FollowUpQueueHost {
    terminalId: string;
    logger: StructuredLogger;
    read(): AgentChatSnapshot;
    apply(operations: AgentChatPatchOperation[]): void;
    /**
     * Whether this Chat is still current and its provider session open.
     */
    canDeliver(): boolean;
    enqueue(deliver: ChatInputDelivery): Promise<void>;
}

/**
 * Delivers one queued input, marked with how it reached the provider.
 */
async function deliverQueuedInput(
    session: AgentChatProviderSession,
    entry: QueuedInput,
    delivery: 'queued' | 'steered',
): Promise<void> {
    await (entry.kind === 'message'
        ? session.send(entry.message, { delivery })
        : session.runCommand(entry.name, entry.arguments, { delivery }));
}

/**
 * One Chat's follow-up queue: messages and commands sent while a turn runs, sent once the Chat is idle. Consecutive
 * messages go out together as one turn (see {@link dispatchBatch}); a command takes a turn of its own. An interrupt
 * pauses it so stopping a turn never fires the next message by surprise.
 */
export class ChatFollowUpQueue {
    private entries: QueuedInput[] = [];
    private isPaused = false;
    /**
     * A queued input is on its way to the provider; the next one waits for the turn it starts to end.
     */
    private isDispatching = false;
    /**
     * A restart handed this queue's entries to its replacement; a dispatch still in flight must not publish or reinsert
     * into the new Chat state.
     */
    private isRetired = false;

    constructor(private readonly host: FollowUpQueueHost) {}

    private publish(): void {
        if (this.isRetired) return;
        this.host.apply([
            { op: 'state', state: { queue: queueView(this.entries), queuePaused: this.isPaused } },
        ]);
    }

    /**
     * `merged` is how many queued entries one dispatch joined into a single input.
     */
    private log(reason: QueueChange, merged?: number): void {
        this.host.logger.write(
            reason === 'dispatchFailed' || reason === 'deliveryUnknown' ? 'warn' : 'info',
            logEventCatalog.agentChat.queueChanged,
            {
                fields: {
                    terminalId: this.host.terminalId,
                    reason,
                    depth: this.entries.length,
                    ...(merged !== undefined && { merged }),
                },
            },
        );
    }

    /**
     * Pauses the queue after an entry may have reached the provider without confirmation, and says so in the timeline:
     * the entry stays for the user to send again or remove, but nothing sends it again on its own.
     */
    private holdUnconfirmed(entry: QueuedInput, error: unknown): void {
        this.isPaused = true;
        this.host.apply([
            {
                op: 'upsertItem',
                item: {
                    id: `delivery-unknown:${entry.id}`,
                    type: 'notice',
                    kind: 'error',
                    message: clip(error instanceof Error ? error.message : String(error), 2_000),
                },
            },
        ]);
        this.log('deliveryUnknown');
    }

    private isIdle(): boolean {
        const snapshot = this.host.read();
        return (
            this.entries.length > 0 &&
            !this.isPaused &&
            !this.isDispatching &&
            snapshot.status === 'ready' &&
            !snapshot.activeTurnId &&
            snapshot.operation !== 'compacting' &&
            this.host.canDeliver()
        );
    }

    /**
     * Takes a dispatch batch out of the queue in one publish.
     */
    private take(batch: readonly QueuedInput[]): void {
        const taken = new Set(batch);
        this.entries = this.entries.filter((entry) => !taken.has(entry));
        if (this.entries.length === 0) this.isPaused = false;
        this.publish();
    }

    private async dispatchNext(): Promise<void> {
        try {
            await this.host.enqueue(async (session) => {
                this.isDispatching = false;
                if (!this.isIdle()) return;
                // `isIdle` guarantees a first entry.
                const batch = dispatchBatch(this.entries);
                this.isDispatching = true;
                this.take(batch);
                try {
                    await deliverQueuedInput(session, mergeBatch(batch), 'queued');
                    this.log('dispatched', batch.length);
                } catch (error) {
                    if (this.isRetired) return;
                    // Keep the inputs and stop the queue, so a failure the user has not seen never drops or repeats them.
                    this.entries.unshift(...batch);
                    this.isPaused = true;
                    if (isDeliveryUnknown(error)) this.holdUnconfirmed(batch[0], error);
                    else this.log('dispatchFailed', batch.length);
                    this.publish();
                }
            });
        } catch {
            // The Chat closed or its provider could not start; that state is already on screen.
        } finally {
            this.isDispatching = false;
        }
    }

    /**
     * Whether a new input has to wait: a turn or compaction is running, or earlier queued inputs are due first.
     */
    mustWait(): boolean {
        const snapshot = this.host.read();
        return (
            Boolean(snapshot.activeTurnId) ||
            snapshot.operation === 'compacting' ||
            (this.entries.length > 0 && !this.isPaused)
        );
    }

    add(entry: QueuedInput): void {
        assertQueueRoom(this.entries, entry);
        this.entries.push(entry);
        this.publish();
        this.log('queued');
        // A turn that ended while this input waited for the send chain leaves nothing else to trigger the queue.
        this.dispatch();
    }

    entry(id: string): QueuedInput {
        const entry = this.entries.find((candidate) => candidate.id === id);
        if (!entry) throw new CaxriError('CONFLICT', 'This message is no longer queued');
        return entry;
    }

    /**
     * Removes an entry. `reason` is logged for a user's removal; a send-now logs once it was delivered.
     */
    remove(id: string, reason?: QueueChange): void {
        this.entry(id);
        this.entries = this.entries.filter((entry) => entry.id !== id);
        if (this.entries.length === 0) this.isPaused = false;
        this.publish();
        if (reason) this.log(reason);
    }

    /**
     * Sends one entry ahead of the rest. A failed send returns it to the same place and rethrows, so a rejected steer
     * never loses the user's message. A send whose delivery is unknown also pauses the queue, so the entries behind it
     * do not go out around a message that may still arrive.
     */
    async sendNow(
        session: AgentChatProviderSession,
        id: string,
        delivery: 'queued' | 'steered',
    ): Promise<void> {
        const entry = this.entry(id);
        const index = this.entries.indexOf(entry);
        this.remove(id);
        try {
            await deliverQueuedInput(session, entry, delivery);
        } catch (error) {
            if (!this.isRetired) {
                this.entries.splice(Math.min(index, this.entries.length), 0, entry);
                if (isDeliveryUnknown(error)) this.holdUnconfirmed(entry, error);
                this.publish();
            }
            throw error;
        }
        this.log('sentNow');
    }

    logSteered(): void {
        this.log('steered');
    }

    pause(): void {
        if (this.entries.length === 0 || this.isPaused) return;
        this.isPaused = true;
        this.publish();
        this.log('paused');
    }

    resume(): void {
        if (!this.isPaused) return;
        this.isPaused = false;
        this.publish();
        this.log('resumed');
        this.dispatch();
    }

    /**
     * Carries a replaced Chat state's queue over a restart; it goes out once the new process is ready.
     */
    adopt(previous: ChatFollowUpQueue): void {
        previous.isRetired = true;
        if (previous.entries.length === 0) return;
        this.entries = [...previous.entries];
        this.isPaused = previous.isPaused;
        this.publish();
    }

    /**
     * Sends the next queued input once the Chat is idle. Called after every projection change, so a turn ending, a
     * restart reaching `ready`, or a resume all advance the queue; only one dispatch is in flight at a time, and the
     * turn it starts holds back the next one. A dispatch joins the run of messages at the head into one input.
     */
    dispatch(): void {
        if (this.isRetired || !this.isIdle()) return;
        this.isDispatching = true;
        // eslint-disable-next-line no-void -- a failed dispatch pauses the queue and is logged; nobody awaits it.
        void this.dispatchNext();
    }
}
