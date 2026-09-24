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
            vi.advanceTimersByTime(5_000);
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
