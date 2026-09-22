import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { releaseE2EHost, stopE2EHost } from './host-shutdown';

const { discover, connect, identity, request, close } = vi.hoisted(() => ({
    discover: vi.fn(),
    connect: vi.fn(),
    identity: vi.fn(),
    request: vi.fn(),
    close: vi.fn(),
}));
vi.mock('@caxri/client/supervise', () => ({
    connectToServer: connect,
    discoverServerManifest: discover,
}));
vi.mock('../../.agents/skills/switch-worktree/scripts/process', () => ({
    getProcessIdentity: identity,
}));
const manifest = { pid: 123, processIdentity: 'host-lifetime' };
const missing = () => Promise.reject(Object.assign(new Error('missing'), { code: 'NOT_FOUND' }));

beforeEach(() => {
    vi.useFakeTimers();
    discover.mockResolvedValue(manifest);
    identity.mockResolvedValue('os-lifetime');
    request.mockResolvedValue({ stopping: true });
    connect.mockResolvedValue({ request, close });
});
afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
});

describe('E2E Host shutdown', () => {
    it('waits beyond the stop acknowledgment and discovery removal for the original process', async () => {
        let isSettled = false;
        const stopping = (async () => {
            await stopE2EHost('/fixture/profile');
            isSettled = true;
        })();
        await vi.advanceTimersByTimeAsync(2_500);
        expect(isSettled).toBe(false);
        discover.mockImplementation(missing);
        await vi.advanceTimersByTimeAsync(500);
        expect(isSettled).toBe(false);
        identity.mockResolvedValue(undefined);
        await vi.advanceTimersByTimeAsync(100);
        await stopping;
        expect(close).toHaveBeenCalledOnce();
    });
    it('does not treat an unavailable socket as proof that a Host exited', async () => {
        connect.mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'UNAVAILABLE' }));
        const stopping = stopE2EHost('/fixture/profile');
        const outcome = expect(stopping).rejects.toThrow('Timed out');
        await vi.advanceTimersByTimeAsync(40_000);
        await outcome;
    });
    it('rejects a replacement Host without stopping it', async () => {
        discover
            .mockResolvedValueOnce(manifest)
            .mockResolvedValue({ ...manifest, processIdentity: 'replacement' });
        await expect(stopE2EHost('/fixture/profile')).rejects.toThrow('replaced');
        expect(request).toHaveBeenCalledTimes(1);
    });
});

it('retains the desktop lease when Host shutdown fails', async () => {
    const release = vi.fn();
    discover.mockRejectedValue(new Error('cannot verify Host'));
    await expect(releaseE2EHost('/fixture/profile', false, release)).rejects.toThrow(
        'cannot verify Host',
    );
    expect(release).not.toHaveBeenCalled();
});
it('releases the lease when a restart explicitly preserves its Host', async () => {
    const release = vi.fn();
    await releaseE2EHost('/fixture/profile', true, release);
    expect(discover).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
});
