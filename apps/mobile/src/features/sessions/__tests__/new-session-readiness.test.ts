import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForCreatedConversation } from '../new-session-readiness';

afterEach(() => vi.useRealTimers());

describe('new Session Conversation readiness', () => {
    it('waits for a transient missing transcript to become readable', async () => {
        vi.useFakeTimers();
        const read = vi
            .fn()
            .mockResolvedValueOnce({ status: 'missing' })
            .mockResolvedValueOnce({ status: 'available' });
        const pending = waitForCreatedConversation(read);
        await vi.advanceTimersByTimeAsync(150);
        await expect(pending).resolves.toBe('ready');
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('falls back when the provider does not support Conversation', async () => {
        const read = vi.fn().mockResolvedValue({ status: 'unsupported' });
        await expect(waitForCreatedConversation(read)).resolves.toBe('fallback');
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('bounds a read that never settles', async () => {
        vi.useFakeTimers();
        const read = vi.fn(() => new Promise<{ status: 'available' }>(() => {}));
        const pending = waitForCreatedConversation(read);
        await vi.advanceTimersByTimeAsync(3_000);
        await expect(pending).resolves.toBe('fallback');
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('falls back after repeated missing transcript results', async () => {
        vi.useFakeTimers();
        const read = vi.fn().mockResolvedValue({ status: 'missing' });
        const pending = waitForCreatedConversation(read);
        await vi.advanceTimersByTimeAsync(3_000);
        await expect(pending).resolves.toBe('fallback');
        expect(read.mock.calls.length).toBeGreaterThan(1);
    });

    it('retries a transient read error until Conversation becomes available', async () => {
        vi.useFakeTimers();
        const read = vi
            .fn()
            .mockRejectedValueOnce(new Error('transient read error'))
            .mockResolvedValueOnce({ status: 'available' });
        const pending = waitForCreatedConversation(read);
        await vi.advanceTimersByTimeAsync(150);
        await expect(pending).resolves.toBe('ready');
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('bounds repeated read failures without throwing', async () => {
        vi.useFakeTimers();
        const read = vi.fn().mockRejectedValue(new Error('connection lost'));
        const pending = waitForCreatedConversation(read);
        await vi.advanceTimersByTimeAsync(3_000);
        await expect(pending).resolves.toBe('fallback');
        expect(read.mock.calls.length).toBeGreaterThan(1);
    });
});
