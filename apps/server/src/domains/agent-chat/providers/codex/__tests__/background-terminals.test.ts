import type { AgentChatPatchOperation, AgentChatSnapshot } from '@caxri/protocol';
import { applyAgentChatOperation, emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ChatTaskList } from '../../../tasks/task-list';
import { CodexBackgroundTerminals } from '../background-terminals';

const LIST = 'thread/backgroundTerminals/list';

interface ListRead {
    resolve: (itemIds: string[]) => void;
}

/**
 * Background terminals over an in-memory snapshot whose `thread/backgroundTerminals/list` reads stay pending until the
 * test answers them, so a read can be held in flight while the Chat moves on.
 */
function terminals() {
    let snapshot: AgentChatSnapshot = emptyAgentChatSnapshot('terminal-1');
    const host = {
        read: () => snapshot,
        apply: (operations: AgentChatPatchOperation[]) => {
            snapshot = operations.reduce(applyAgentChatOperation, snapshot);
        },
        applyTask: vi.fn(),
    };
    const reads: ListRead[] = [];
    const request = vi.fn((method: string) => {
        if (method !== LIST) return Promise.reject(new Error(`unexpected ${method}`));
        return new Promise<unknown>((resolve) => {
            reads.push({
                resolve: (itemIds) =>
                    resolve({
                        data: itemIds.map((itemId) => ({ itemId, processId: `p-${itemId}` })),
                        nextCursor: null,
                    }),
            });
        });
    });
    const subject = new CodexBackgroundTerminals(host, new ChatTaskList(host), {
        request,
        threadId: () => 'thread-1',
    });
    /**
     * Starts a unified-exec command in `turn-1` and ends that turn, so the command runs in the background.
     */
    const background = (itemId: string) => {
        subject.onItem(
            { id: itemId, processId: `p-${itemId}`, command: 'bun run dev', status: 'inProgress' },
            'turn-1',
            true,
        );
        subject.onTurnFinished('turn-1');
    };
    const status = (itemId: string) => snapshot.tasks?.find((task) => task.id === itemId)?.status;
    return { subject, reads, request, background, status };
}

describe('CodexBackgroundTerminals.reconcile', () => {
    it('reads the list again for a reconcile requested while a read is in flight', async () => {
        const { subject, reads, request, background, status } = terminals();
        background('cmd');
        const first = subject.reconcile();
        await vi.waitFor(() => expect(reads).toHaveLength(1));

        // A later turn ends after Codex reaped the terminal; the read in flight predates that.
        const second = subject.reconcile();
        const third = subject.reconcile();
        reads[0].resolve(['cmd']);
        await vi.waitFor(() => expect(reads).toHaveLength(2));
        expect(status('cmd')).toBe('running');
        reads[1].resolve([]);
        await Promise.all([first, second, third]);

        expect(status('cmd')).toBe('stopped');
        // Both late requests share the one extra read.
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('does not take back a terminal that finished while the list was being read', async () => {
        const { subject, reads, background, status } = terminals();
        background('cmd');
        const reconciled = subject.reconcile();
        await vi.waitFor(() => expect(reads).toHaveLength(1));

        // Codex completes the command after it answered the list, but before Caxri read the answer.
        subject.onItem({ id: 'cmd', processId: 'p-cmd', status: 'failed' }, 'turn-1', false);
        expect(status('cmd')).toBe('failed');
        reads[0].resolve(['cmd']);
        await reconciled;

        expect(status('cmd')).toBe('failed');
    });
});
