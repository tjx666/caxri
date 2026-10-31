import { describe, expect, it, vi } from 'vitest';

import { MobileHeartbeat } from '../mobile-heartbeat';

describe('mobile heartbeat', () => {
    it('sends one nonce at a time and accepts only the matching acknowledgement', () => {
        vi.useFakeTimers();
        try {
            const send = vi.fn();
            const onTimeout = vi.fn();
            const heartbeat = new MobileHeartbeat({
                randomBytes: (size) => new Uint8Array(size).fill(1),
                send,
                onTimeout,
            });
            heartbeat.start();
            vi.advanceTimersByTime(3_000);
            expect(send).toHaveBeenCalledExactlyOnceWith({
                type: 'heartbeat',
                nonce: '01'.repeat(16),
            });
            expect(() => heartbeat.acknowledge('02'.repeat(16))).toThrow('nonce');
            heartbeat.acknowledge('01'.repeat(16));
            vi.advanceTimersByTime(5_000);
            expect(onTimeout).not.toHaveBeenCalled();
            heartbeat.stop();
            expect(() => heartbeat.acknowledge('01'.repeat(16))).not.toThrow();
        } finally {
            vi.useRealTimers();
        }
    });

    it('ignores a late acknowledgement for a heartbeat sent before a background pause', () => {
        vi.useFakeTimers();
        try {
            let fill = 0;
            const send = vi.fn();
            const onTimeout = vi.fn();
            const heartbeat = new MobileHeartbeat({
                randomBytes: (size) => new Uint8Array(size).fill((fill += 1)),
                send,
                onTimeout,
            });
            heartbeat.start();
            vi.advanceTimersByTime(3_000);
            heartbeat.stop();
            heartbeat.start();
            vi.advanceTimersByTime(3_000);
            expect(send).toHaveBeenLastCalledWith({ type: 'heartbeat', nonce: '02'.repeat(16) });
            // A Server that stalled answers the heartbeat from before the pause after the new one went out.
            expect(() => heartbeat.acknowledge('01'.repeat(16))).not.toThrow();
            expect(() => heartbeat.acknowledge('03'.repeat(16))).toThrow('nonce');
            heartbeat.acknowledge('02'.repeat(16));
            vi.advanceTimersByTime(7_000);
            expect(onTimeout).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('waits eight seconds for an acknowledgement so a stalled computer is not dropped', () => {
        vi.useFakeTimers();
        try {
            const onTimeout = vi.fn();
            const heartbeat = new MobileHeartbeat({
                randomBytes: (size) => new Uint8Array(size).fill(4),
                send: vi.fn(),
                onTimeout,
            });
            heartbeat.start();
            vi.advanceTimersByTime(3_000 + 7_999);
            expect(onTimeout).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(onTimeout).toHaveBeenCalledOnce();
            heartbeat.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('times out a missing acknowledgement and cleans up timers in background', () => {
        vi.useFakeTimers();
        try {
            const send = vi.fn();
            const onTimeout = vi.fn();
            const heartbeat = new MobileHeartbeat({
                randomBytes: (size) => new Uint8Array(size).fill(3),
                send,
                onTimeout,
            });
            heartbeat.start();
            vi.advanceTimersByTime(3_000);
            vi.advanceTimersByTime(8_000);
            expect(onTimeout).toHaveBeenCalledOnce();
            heartbeat.stop();
            vi.advanceTimersByTime(20_000);
            expect(send).toHaveBeenCalledOnce();
            expect(onTimeout).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });
});
