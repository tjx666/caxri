import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = vi.hoisted(() => vi.fn());
vi.mock('../../../../scripts/exec', () => ({ execFileAsync }));

const { getProcessIdentity, isProcessIdentityAlive } = await import('./process');

const PS_OUTPUT = { stdout: 'Mon Oct 31 10:00:00 2026 /bin/sleep 100\n', stderr: '' };

describe('process identity probing', () => {
    beforeEach(() => {
        // Block body: a returned mock would be invoked by Vitest as a teardown callback.
        execFileAsync.mockReset();
    });

    it('treats a transient ps failure as alive after retries', async () => {
        execFileAsync.mockRejectedValue(
            Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }),
        );
        expect(await isProcessIdentityAlive(4242, 'whatever')).toBe(true);
        expect(execFileAsync).toHaveBeenCalledTimes(3);
    });

    it('recovers when a retry succeeds', async () => {
        execFileAsync.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 2 }));
        execFileAsync.mockResolvedValue(PS_OUTPUT);
        const identity = await getProcessIdentity(4242);
        expect(identity).toBeTypeOf('string');
        expect(await isProcessIdentityAlive(4242, identity!)).toBe(true);
        expect(await isProcessIdentityAlive(4242, 'other')).toBe(false);
    });

    it('reports a missing process (exit 1, empty output) as dead without retrying', async () => {
        execFileAsync.mockRejectedValue(
            Object.assign(new Error('Command failed'), { code: 1, stdout: '', stderr: '' }),
        );
        expect(await isProcessIdentityAlive(4242, 'x')).toBe(false);
        expect(execFileAsync).toHaveBeenCalledTimes(1);
    });
});
