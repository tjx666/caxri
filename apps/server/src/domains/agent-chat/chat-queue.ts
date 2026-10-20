import type {
    AgentChatMessageInput,
    AgentChatPatchOperation,
    AgentChatQueuedMessage,
    AgentChatSnapshot,
} from '@caxri/protocol';
import {
    agentChatTextWithOffsetImages,
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

type QueuePauseReason = NonNullable<AgentChatSnapshot['queuePauseReason']>;

/**
 * Closed reasons for the `agent_chat.queue_changed` log.
 */
type QueueChange =
    | 'deliveryUnknown'
    | 'dispatched'
    | 'dispatchFailed'
    | 'editedInPlace'
    | 'paused'
    | 'queued'
    | 'removed'
    | 'restored'
    | 'resumed'
    | 'sentNow'
    | 'steered'
    | 'takenForEdit';

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
 * image-only message adds no blank paragraph. Each message's `[Image #N]` placeholders move past the images of the
 * messages before it, so they still name its own images.
 */
function mergeBatch(batch: readonly QueuedInput[]): QueuedInput {
    const [first] = batch;
    if (batch.length === 1) return first;
    const messages = batch as readonly QueuedMessage[];
    const images = messages.flatMap((entry) => entry.message.images ?? []);
    let imageOffset = 0;
    const texts = messages.map(({ message }) => {
        const imageCount = message.images?.length ?? 0;
        const text = agentChatTextWithOffsetImages(message.text, imageOffset, imageCount);
        imageOffset += imageCount;
        return text;
    });
    return {
        id: first.id,
        kind: 'message',
        message: {
            text: texts.filter((text) => text.length > 0).join(MERGED_MESSAGE_SEPARATOR),
            ...(images.length > 0 && { images }),
        },
    };
}

/**
 * How many deleted entries stay restorable. Each may hold images, so the stash is bounded like the queue itself.
 */
const MAX_RESTORABLE_QUEUE_ENTRIES = 10;

/**
 * An entry the user deleted, with the entry that followed it so Undo can put it back in the same place.
 */
interface RemovedQueuedInput {
    entry: QueuedInput;
    /**
     * The id of the entry that came right after it, or `undefined` when it was last.
     */
    beforeId: string | undefined;
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
    /**
     * Why the queue is paused, or `undefined` while it runs. Published as `queuePaused` plus `queuePauseReason`, so a
     * Client can tell a failed send (which wants Retry) from the user's own Stop.
     */
    private pauseReason: QueuePauseReason | undefined;
    /**
     * A queued input is on its way to the provider; the next one waits for the turn it starts to end.
     */
    private isDispatching = false;
    /**
     * A restart handed this queue's entries to its replacement; a dispatch still in flight must not publish or reinsert
     * into the new Chat state.
     */
    private isRetired = false;
    /**
     * Entries the user deleted, newest last, kept for Undo (see {@link restoreRemoved}).
     */
    private removedEntries: RemovedQueuedInput[] = [];

    constructor(private readonly host: FollowUpQueueHost) {}

    private publish(): void {
        if (this.isRetired) return;
        this.host.apply([
            {
                op: 'state',
                state: {
                    queue: queueView(this.entries),
                    queuePaused: this.pauseReason !== undefined,
                    queuePauseReason: this.pauseReason ?? null,
                },
            },
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
        this.pauseReason = 'deliveryUnknown';
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
            this.pauseReason === undefined &&
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
        if (this.entries.length === 0) this.pauseReason = undefined;
        this.publish();
    }

    private async dispatchNext(): Promise<void> {
        /**
         * Set inside the delivery callback; held in an object because narrowing cannot see that assignment.
         */
        const outcome = { isMessageDelivered: false };
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
                    outcome.isMessageDelivered = batch[0].kind === 'message';
                } catch (error) {
                    if (this.isRetired) return;
                    // Keep the inputs and stop the queue, so a failure the user has not seen never drops or repeats them.
                    this.entries.unshift(...batch);
                    if (isDeliveryUnknown(error)) this.holdUnconfirmed(batch[0], error);
                    else {
                        this.pauseReason = 'sendFailed';
                        this.log('dispatchFailed', batch.length);
                    }
                    this.publish();
                }
            });
        } catch {
            // The Chat closed or its provider could not start; that state is already on screen.
        } finally {
            this.isDispatching = false;
        }
        // The turn this input started may already have ended while the delivery was in flight (a turn start response
        // and its completion read from one stdout chunk). That projection change was dropped by `isDispatching`, and
        // nothing else would advance the queue, so check again. `dispatch` re-reads `isIdle`, so a running turn still
        // holds the next entry back. Only after a confirmed delivery: a failure paused the queue, and a Chat whose
        // provider could not start must not retry in a loop. Only after a message: a command such as Codex `/compact`
        // resolves before the provider reports the turn it starts, so the Chat would read idle and the next entry
        // would go out into that compaction. Its turn notifications advance the queue instead.
        if (outcome.isMessageDelivered) this.dispatch();
    }

    /**
     * Whether a new input has to wait: a turn or compaction is running, or earlier queued inputs are due first.
     */
    mustWait(): boolean {
        const snapshot = this.host.read();
        return (
            Boolean(snapshot.activeTurnId) ||
            snapshot.operation === 'compacting' ||
            (this.entries.length > 0 && this.pauseReason === undefined)
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
        if (this.entries.length === 0) this.pauseReason = undefined;
        this.publish();
        if (reason) this.log(reason);
    }

    /**
     * The queue card's Delete: removes an entry and keeps it, images included, so {@link restoreRemoved} can put it back
     * where it was.
     */
    removeForUndo(id: string): void {
        const entry = this.entry(id);
        const index = this.entries.indexOf(entry);
        const beforeId = this.entries.at(index + 1)?.id;
        this.remove(id, 'removed');
        this.removedEntries.push({ entry, beforeId });
        if (this.removedEntries.length > MAX_RESTORABLE_QUEUE_ENTRIES) this.removedEntries.shift();
    }

    /**
     * Undo of a Delete: puts the entry back just ahead of the one that followed it, or at the end when that one has
     * left the queue since. Fails with `CONFLICT` when the entry cannot be restored (forgotten, or the Chat restarted).
     * The queue may send it at once when the Chat is idle and the queue is not paused, exactly as a new entry would.
     */
    restoreRemoved(id: string): void {
        const index = this.removedEntries.findIndex((removed) => removed.entry.id === id);
        if (index === -1 || this.entries.some((entry) => entry.id === id))
            throw new CaxriError('CONFLICT', 'This message can no longer be restored');
        const [{ entry, beforeId }] = this.removedEntries.splice(index, 1);
        try {
            assertQueueRoom(this.entries, entry);
        } catch (error) {
            this.removedEntries.splice(index, 0, { entry, beforeId });
            throw error;
        }
        const position = this.entries.findIndex((candidate) => candidate.id === beforeId);
        this.entries.splice(position === -1 ? this.entries.length : position, 0, entry);
        this.publish();
        this.log('restored');
        this.dispatch();
    }

    /**
     * Rewrites a queued message's text where it stands, keeping its images and its place in the queue: the Edit of a
     * message whose images cannot return to a composer. A command has no images and is edited through
     * {@link takeForEdit}; an emptied message with no images is refused.
     */
    editText(id: string, text: string): void {
        const entry = this.entry(id);
        if (entry.kind !== 'message')
            throw new CaxriError('VALIDATION', 'A queued command cannot be edited in place');
        if (text.trim() === '' && (entry.message.images?.length ?? 0) === 0)
            throw new CaxriError('VALIDATION', 'A queued message cannot be empty');
        const edited: QueuedMessage = { ...entry, message: { ...entry.message, text } };
        assertQueueRoom(
            this.entries.filter((candidate) => candidate !== entry),
            edited,
        );
        this.entries[this.entries.indexOf(entry)] = edited;
        this.publish();
        this.log('editedInPlace');
    }

    /**
     * Takes an entry back for editing: removes it and returns the full text Edit puts in the composer, in one step, so
     * an entry the queue sends meanwhile is never both sent and back in a draft. A Client may hold only a preview of
     * the text (the phone's `clipAgentChatQueueForMobile`), so the text comes from here. A message carrying images
     * stays queued and fails with `VALIDATION`: images never return to a composer, and editing must not silently drop
     * them.
     */
    takeForEdit(id: string): { text: string } {
        const entry = this.entry(id);
        if (entry.kind === 'message' && (entry.message.images?.length ?? 0) > 0)
            throw new CaxriError('VALIDATION', 'A queued message with images cannot be edited');
        const [{ text }] = queueView([entry]);
        this.remove(id, 'takenForEdit');
        return { text };
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

    /**
     * Pauses the queue after the user stopped a turn. A queue a failure already paused keeps that reason: the failure
     * is still what the user has to act on.
     */
    pause(): void {
        if (this.entries.length === 0 || this.pauseReason !== undefined) return;
        this.pauseReason = 'stopped';
        this.publish();
        this.log('paused');
    }

    /**
     * Lifts a pause. True when queued inputs were waiting: they now go out through the send chain, so a caller can
     * still record them as human input before they are delivered.
     */
    resume(): boolean {
        if (this.pauseReason === undefined) return false;
        this.pauseReason = undefined;
        this.publish();
        this.log('resumed');
        this.dispatch();
        return this.entries.length > 0;
    }

    /**
     * Carries a replaced Chat state's queue over a restart; it goes out once the new process is ready.
     */
    adopt(previous: ChatFollowUpQueue): void {
        previous.isRetired = true;
        if (previous.entries.length === 0) return;
        this.entries = [...previous.entries];
        this.pauseReason = previous.pauseReason;
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
