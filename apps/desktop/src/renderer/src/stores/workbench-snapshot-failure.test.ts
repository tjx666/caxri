import { CaxriError, SERVER_BUSY_DETAILS } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dismissToast, getToasts } from './toasts';
import {
    createSnapshotFailureHandler,
    SNAPSHOT_BUSY_RETRY_DELAYS_MS,
} from './workbench-snapshot-failure';

const busy = (): CaxriError =>
    new CaxriError('CAPACITY', 'Too many requests are in flight', SERVER_BUSY_DETAILS);

function createHarness() {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const retry = vi.fn();
    const handler = createSnapshotFailureHandler(retry, (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
    });
    /**
     * Runs the one pending retry, the way its timer would.
     */
    const fire = (): void => {
        const next = scheduled.shift();
        expect(next).toBeDefined();
        next!.callback();
    };
    return { handler, retry, scheduled, fire };
}

afterEach(() => {
    dismissToast();
});

describe('createSnapshotFailureHandler', () => {
    it('names a failed first snapshot as a load', () => {
        createHarness().handler.failed(new Error('The Server stopped.'), false);
        expect(getToasts()).toEqual([
            expect.objectContaining({
                type: 'error',
                title: 'Unable to load Projects and Sessions from the Server. The Server stopped.',
            }),
        ]);
    });

    it('names a failed later snapshot as a refresh of what is already shown', () => {
        createHarness().handler.failed(new Error('The Server stopped.'), true);
        expect(getToasts()).toEqual([
            expect.objectContaining({
                type: 'error',
                title: 'Unable to refresh Projects and Sessions from the Server. The Server stopped.',
            }),
        ]);
    });

    it('stays silent for a request cancelled by quit', () => {
        createHarness().handler.failed(new CaxriError('CANCELLED', 'Request cancelled'), true);
        expect(getToasts()).toEqual([]);
    });

    it('retries a read the busy Server shed instead of reporting it', () => {
        const { handler, retry, scheduled, fire } = createHarness();
        handler.failed(busy(), true);
        expect(getToasts()).toEqual([]);
        expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([SNAPSHOT_BUSY_RETRY_DELAYS_MS[0]]);
        fire();
        expect(retry).toHaveBeenCalledOnce();
    });

    it('shares one pending retry between concurrent busy failures', () => {
        const { handler, scheduled } = createHarness();
        handler.failed(busy(), true);
        handler.failed(busy(), true);
        expect(scheduled).toHaveLength(1);
    });

    it('reports a Server still busy after the whole retry budget as busy, not as a limit', () => {
        const { handler, fire } = createHarness();
        for (let attempt = 0; attempt < SNAPSHOT_BUSY_RETRY_DELAYS_MS.length; attempt += 1) {
            handler.failed(busy(), true);
            fire();
        }
        expect(getToasts()).toEqual([]);
        handler.failed(busy(), true);
        expect(getToasts()).toEqual([
            expect.objectContaining({
                type: 'error',
                title: 'Unable to refresh Projects and Sessions from the Server. Caxri is busy. Try again in a moment.',
            }),
        ]);
    });

    it('restores the full retry budget after a successful read', () => {
        const { handler, scheduled, fire } = createHarness();
        for (let attempt = 0; attempt < SNAPSHOT_BUSY_RETRY_DELAYS_MS.length; attempt += 1) {
            handler.failed(busy(), true);
            fire();
        }
        handler.succeeded();
        handler.failed(busy(), true);
        expect(getToasts()).toEqual([]);
        expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([SNAPSHOT_BUSY_RETRY_DELAYS_MS[0]]);
    });
});
