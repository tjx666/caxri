import type {
    AgentChatImageInput,
    AgentChatPatchOperation,
    AgentChatSnapshot,
} from '@caxri/protocol';
import { MAX_AGENT_CHAT_IMAGES, MAX_AGENT_CHAT_MESSAGE_LENGTH } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { AgentChatProviderSession } from '../chat-provider';
import { ChatFollowUpQueue } from '../chat-queue';

type Sent =
    { kind: 'message'; text: string; imageCount: number } | { kind: 'command'; name: string };

const image: AgentChatImageInput = { mediaType: 'image/png', data: 'AAAA', thumbnail: '' };

/**
 * A queue over an idle Chat whose provider records each input it receives; `failNext` makes the next send throw.
 */
function queueFixture() {
    const sent: Sent[] = [];
    const state: { snapshot: Partial<AgentChatSnapshot>; failNext: boolean } = {
        snapshot: { status: 'ready', queue: [] },
        failNext: false,
    };
    const session = {
        send: vi.fn((message: { text: string; images?: unknown[] }) => {
            if (state.failNext) {
                state.failNext = false;
                return Promise.reject(new Error('refused'));
            }
            sent.push({
                kind: 'message',
                text: message.text,
                imageCount: message.images?.length ?? 0,
            });
            return Promise.resolve();
        }),
        runCommand: vi.fn((name: string) => {
            sent.push({ kind: 'command', name });
            return Promise.resolve();
        }),
    } as unknown as AgentChatProviderSession;
    let chain = Promise.resolve();
    const queue = new ChatFollowUpQueue({
        terminalId: 'terminal-1',
        logger: { write: vi.fn() } as unknown as StructuredLogger,
        read: () => state.snapshot as AgentChatSnapshot,
        apply: (operations: AgentChatPatchOperation[]) => {
            for (const operation of operations)
                if (operation.op === 'state')
                    state.snapshot = {
                        ...state.snapshot,
                        ...operation.state,
                    } as Partial<AgentChatSnapshot>;
        },
        canDeliver: () => true,
        enqueue: (deliver) => {
            const previous = chain;
            chain = (async () => {
                await previous;
                await deliver(session);
            })();
            return chain;
        },
    });
    /**
     * Holds the queue as a running turn would, so entries collect before the next dispatch.
     */
    const hold = (): void => {
        state.snapshot = { ...state.snapshot, activeTurnId: 'turn-1' };
    };
    /**
     * Ends the turn and lets the dispatch it triggers settle.
     */
    const endTurn = async (): Promise<void> => {
        state.snapshot = { ...state.snapshot, activeTurnId: undefined };
        queue.dispatch();
        await chain;
        await chain;
    };
    const queuedTexts = () => state.snapshot.queue?.map((entry) => entry.text);
    return { endTurn, hold, queue, queuedTexts, sent, state };
}

const message = (text: string, images: AgentChatImageInput[] = []) => ({
    id: crypto.randomUUID(),
    kind: 'message' as const,
    message: { text, ...(images.length > 0 && { images }) },
});
const command = (name: string) => ({ id: crypto.randomUUID(), kind: 'command' as const, name });

describe('ChatFollowUpQueue dispatch', () => {
    it('joins consecutive queued messages into one input with every image', async () => {
        const { endTurn, hold, queue, queuedTexts, sent } = queueFixture();
        hold();
        queue.add(message('first'));
        queue.add(message('', [image]));
        queue.add(message('second', [image]));
        await endTurn();
        expect(sent).toEqual([{ kind: 'message', text: 'first\n\nsecond', imageCount: 2 }]);
        expect(queuedTexts()).toEqual([]);
    });

    it('sends a command on its own turn, between the messages around it', async () => {
        const { endTurn, hold, queue, queuedTexts, sent } = queueFixture();
        hold();
        queue.add(message('before one'));
        queue.add(message('before two'));
        queue.add(command('compact'));
        queue.add(message('after'));
        await endTurn();
        expect(sent).toEqual([
            { kind: 'message', text: 'before one\n\nbefore two', imageCount: 0 },
        ]);
        expect(queuedTexts()).toEqual(['/compact', 'after']);

        // Each dispatch starts a turn, which holds back the next one until it ends.
        hold();
        await endTurn();
        hold();
        await endTurn();
        expect(sent.slice(1)).toEqual([
            { kind: 'command', name: 'compact' },
            { kind: 'message', text: 'after', imageCount: 0 },
        ]);
    });

    it('stops joining where one message could not carry the next', async () => {
        const { endTurn, hold, queue, queuedTexts, sent } = queueFixture();
        hold();
        const half = 'a'.repeat(MAX_AGENT_CHAT_MESSAGE_LENGTH / 2);
        queue.add(message(half));
        queue.add(message(half, [image]));
        queue.add(
            message(
                '',
                Array.from({ length: MAX_AGENT_CHAT_IMAGES }, () => image),
            ),
        );
        await endTurn();
        // The second half and its separator would pass one message's text length.
        expect(sent).toEqual([{ kind: 'message', text: half, imageCount: 0 }]);
        expect(queuedTexts()).toHaveLength(2);

        hold();
        await endTurn();
        // The last message's images would pass one message's image count.
        expect(sent.at(-1)).toEqual({ kind: 'message', text: half, imageCount: 1 });
        expect(queuedTexts()).toHaveLength(1);
    });

    it('puts every joined message back in order and pauses when the send fails', async () => {
        const { endTurn, hold, queue, queuedTexts, sent, state } = queueFixture();
        hold();
        queue.add(message('first'));
        queue.add(message('second'));
        queue.add(command('compact'));
        state.failNext = true;
        await endTurn();
        expect(sent).toEqual([]);
        expect(queuedTexts()).toEqual(['first', 'second', '/compact']);
        expect(state.snapshot.queuePaused).toBe(true);
        expect(state.snapshot.queuePauseReason).toBe('sendFailed');
    });

    it('says why the queue paused and clears the reason once it resumes', async () => {
        const { endTurn, hold, queue, state } = queueFixture();
        hold();
        queue.add(message('first'));
        queue.pause();
        expect(state.snapshot).toMatchObject({ queuePaused: true, queuePauseReason: 'stopped' });

        queue.resume();
        expect(state.snapshot).toMatchObject({ queuePaused: false, queuePauseReason: null });

        state.failNext = true;
        await endTurn();
        expect(state.snapshot.queuePauseReason).toBe('sendFailed');
        // A Stop after a failure keeps the failure as the reason the user has to act on.
        queue.pause();
        expect(state.snapshot.queuePauseReason).toBe('sendFailed');

        queue.resume();
        await endTurn();
        expect(state.snapshot).toMatchObject({
            queue: [],
            queuePaused: false,
            queuePauseReason: null,
        });
    });
});

describe('ChatFollowUpQueue takeForEdit', () => {
    it('removes an entry and returns its whole text, a command as typed', () => {
        const { hold, queue, queuedTexts } = queueFixture();
        hold();
        const long = message('x'.repeat(5_000));
        const compact = { ...command('compact'), arguments: 'keep the plan' };
        queue.add(long);
        queue.add(compact);
        expect(queue.takeForEdit(long.id)).toEqual({ text: 'x'.repeat(5_000) });
        expect(queue.takeForEdit(compact.id)).toEqual({ text: '/compact keep the plan' });
        expect(queuedTexts()).toEqual([]);
    });

    it('refuses an entry that already left the queue, so it is never both sent and edited', async () => {
        const { endTurn, hold, queue, sent } = queueFixture();
        hold();
        const entry = message('send me');
        queue.add(entry);
        await endTurn();
        expect(sent).toEqual([{ kind: 'message', text: 'send me', imageCount: 0 }]);
        expect(() => queue.takeForEdit(entry.id)).toThrow(
            expect.objectContaining({ code: 'CONFLICT' }),
        );
    });

    it('keeps a message with images queued instead of dropping its images', () => {
        const { hold, queue, queuedTexts } = queueFixture();
        hold();
        const entry = message('look', [image]);
        queue.add(entry);
        expect(() => queue.takeForEdit(entry.id)).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }),
        );
        expect(queuedTexts()).toEqual(['look']);
    });
});
