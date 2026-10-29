import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

import { relayCloseCodes } from '@caxri/mobile-transport';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

import type { SpliceEnd } from '../splice';
import { Splice } from '../splice';

/**
 * A socket double whose send buffer the test controls, since loopback sockets drain too fast to cross a watermark.
 */
// eslint-disable-next-line unicorn/prefer-event-target -- doubles a `ws` socket, which is a Node EventEmitter
class FakeSocket extends EventEmitter {
    bufferedAmount = 0;
    isPaused = false;
    readyState = 1;
    readonly sent: Array<{ data: unknown; binary: boolean }> = [];
    closedWith?: { code: number; reason?: unknown };

    send(data: unknown, options: { binary: boolean }): void {
        this.sent.push({ data, binary: options.binary });
    }

    pause(): void {
        this.isPaused = true;
    }

    resume(): void {
        this.isPaused = false;
    }

    close(code: number, reason?: unknown): void {
        if (this.readyState === 3) return;
        this.closedWith = { code, reason };
        this.readyState = 3;
        this.emit('close', code, reason ?? Buffer.alloc(0));
    }

    terminate(): void {
        this.close(1006);
    }
}

const limits = {
    pauseAboveBytes: 100,
    resumeBelowBytes: 10,
    maxDirectionBufferedBytes: 1_000,
    maxPausedMs: 200,
};

const splice = () => {
    const client = new FakeSocket();
    const host = new FakeSocket();
    const ends: SpliceEnd[] = [];
    new Splice({
        client: client as unknown as WebSocket,
        host: host as unknown as WebSocket,
        hostId: 'a'.repeat(32),
        keyHash: 'b'.repeat(64),
        limits,
        onEnd: (end) => ends.push(end),
    });
    return { client, host, ends };
};

afterEach(() => {
    vi.useRealTimers();
});

describe('Splice', () => {
    it('forwards frames with their binary flag in both directions', () => {
        const { client, host, ends } = splice();
        client.emit('message', Buffer.from('text'), false);
        host.emit('message', Buffer.from([1, 2]), true);
        expect(host.sent).toEqual([{ data: Buffer.from('text'), binary: false }]);
        expect(client.sent).toEqual([{ data: Buffer.from([1, 2]), binary: true }]);
        client.close(1000);
        expect(ends[0]).toMatchObject({ cause: 'client-closed', bytesUp: 4, bytesDown: 2 });
    });

    it('pauses the source above the high watermark and resumes below the low one', () => {
        vi.useFakeTimers();
        const { client, host } = splice();
        host.bufferedAmount = 150;
        client.emit('message', Buffer.from('x'), false);
        expect(client.isPaused).toBe(true);

        host.bufferedAmount = 50;
        vi.advanceTimersByTime(50);
        expect(client.isPaused).toBe(true);
        host.bufferedAmount = 5;
        vi.advanceTimersByTime(50);
        expect(client.isPaused).toBe(false);
    });

    it('ends both sides as capacity when a direction stays paused too long or overflows', () => {
        vi.useFakeTimers();
        const stuck = splice();
        stuck.host.bufferedAmount = 150;
        stuck.client.emit('message', Buffer.from('x'), false);
        vi.advanceTimersByTime(300);
        expect(stuck.client.closedWith?.code).toBe(relayCloseCodes.capacity);
        expect(stuck.ends[0]?.cause).toBe('capacity');

        const flooded = splice();
        flooded.client.bufferedAmount = 2_000;
        flooded.host.emit('message', Buffer.from('x'), false);
        expect(flooded.host.closedWith?.code).toBe(relayCloseCodes.capacity);
    });

    it('mirrors application close codes and maps transport failures to peer-gone', () => {
        const kept = splice();
        kept.client.close(4001, Buffer.from('bye'));
        expect(kept.host.closedWith).toEqual({ code: 4001, reason: Buffer.from('bye') });

        const normal = splice();
        normal.host.close(1000);
        expect(normal.client.closedWith?.code).toBe(1000);

        const vanished = splice();
        vanished.host.close(1006);
        expect(vanished.client.closedWith?.code).toBe(relayCloseCodes['peer-gone']);
        expect(vanished.ends[0]?.cause).toBe('host-closed');
    });
});
