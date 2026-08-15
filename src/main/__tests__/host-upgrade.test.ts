import { CaxriError } from '../../shared/ipc/errors';
import { describe, expect, it, vi } from 'vitest';
import {
    recoverLegacyV1Host,
    startHostWithLegacyV1Recovery,
    type LegacyV1HostControl,
} from '../host-upgrade';

function legacyControl(activePtyCount: number): LegacyV1HostControl {
    return {
        close: vi.fn(),
        status: vi.fn(() => Promise.resolve({ activePtyCount })),
        stop: vi.fn(() => Promise.resolve()),
        waitForRelease: vi.fn(() => Promise.resolve()),
    };
}

describe('legacy Host protocol recovery', () => {
    const legacyConflict = new CaxriError(
        'CONFLICT',
        'Caxri Host protocol version is incompatible',
        {
            clientProtocolVersion: 2,
            hostProtocolVersion: 1,
        },
    );

    it('confirms before replacing a legacy Host with live PTYs', async () => {
        const control = legacyControl(3);
        const prompt = vi.fn(() => Promise.resolve(true));

        await expect(
            recoverLegacyV1Host(legacyConflict, {
                connectLegacyControl: () => Promise.resolve(control),
                prompt,
            }),
        ).resolves.toEqual({ outcome: 'retry' });

        expect(prompt).toHaveBeenCalledWith(3);
        expect(control.stop).toHaveBeenCalledWith(true);
        expect(control.waitForRelease).toHaveBeenCalledOnce();
        expect(control.close).toHaveBeenCalledOnce();
    });

    it('stops an idle legacy Host without live-PTY confirmation after an explicit continue', async () => {
        const control = legacyControl(0);

        await expect(
            recoverLegacyV1Host(legacyConflict, {
                connectLegacyControl: () => Promise.resolve(control),
                prompt: () => Promise.resolve(true),
            }),
        ).resolves.toEqual({ outcome: 'retry' });

        expect(control.stop).toHaveBeenCalledWith(false);
    });

    it('preserves the legacy Host when the user cancels', async () => {
        const control = legacyControl(2);

        await expect(
            recoverLegacyV1Host(legacyConflict, {
                connectLegacyControl: () => Promise.resolve(control),
                prompt: () => Promise.resolve(false),
            }),
        ).resolves.toEqual({ outcome: 'quit', reason: 'cancelled' });

        expect(control.stop).not.toHaveBeenCalled();
        expect(control.waitForRelease).not.toHaveBeenCalled();
    });

    it('fails closed when legacy identity release fails', async () => {
        const control = legacyControl(1);
        vi.mocked(control.waitForRelease).mockRejectedValueOnce(new Error('identity changed'));

        await expect(
            recoverLegacyV1Host(legacyConflict, {
                connectLegacyControl: () => Promise.resolve(control),
                prompt: () => Promise.resolve(true),
            }),
        ).resolves.toEqual({ outcome: 'quit', reason: 'failed' });
    });

    it.each(['NOT_FOUND', 'UNAVAILABLE'] as const)(
        'retries detection when the legacy Host disappears with %s',
        async (code) => {
            await expect(
                recoverLegacyV1Host(legacyConflict, {
                    connectLegacyControl: () =>
                        Promise.reject(new CaxriError(code, 'Legacy Host disappeared')),
                    prompt: () => Promise.resolve(true),
                }),
            ).resolves.toEqual({ outcome: 'retry' });
        },
    );

    it('does not recover unrelated protocol conflicts', async () => {
        const connectLegacyControl = vi.fn();

        await expect(
            recoverLegacyV1Host(
                new CaxriError('CONFLICT', 'Caxri Host protocol version is incompatible', {
                    clientProtocolVersion: 2,
                    hostProtocolVersion: 3,
                }),
                { connectLegacyControl, prompt: () => Promise.resolve(true) },
            ),
        ).resolves.toEqual({ outcome: 'not-applicable' });

        expect(connectLegacyControl).not.toHaveBeenCalled();
    });

    it('retries startup only after a confirmed legacy Host release', async () => {
        const control = legacyControl(0);
        const startHost = vi
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(legacyConflict)
            .mockResolvedValueOnce();
        const onAttached = vi.fn();

        await expect(
            startHostWithLegacyV1Recovery({
                connectLegacyControl: () => Promise.resolve(control),
                onAttached,
                onAttachFailed: vi.fn(),
                onUpgradeQuit: vi.fn(),
                prompt: () => Promise.resolve(true),
                startHost,
            }),
        ).resolves.toBe(true);

        expect(startHost).toHaveBeenCalledTimes(2);
        expect(onAttached).toHaveBeenCalledWith(true);
    });

    it('retries startup when the legacy control endpoint has already disappeared', async () => {
        const startHost = vi
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(legacyConflict)
            .mockResolvedValueOnce();
        const onAttached = vi.fn();

        await expect(
            startHostWithLegacyV1Recovery({
                connectLegacyControl: () =>
                    Promise.reject(new CaxriError('UNAVAILABLE', 'Legacy Host disappeared')),
                onAttached,
                onAttachFailed: vi.fn(),
                onUpgradeQuit: vi.fn(),
                prompt: () => Promise.resolve(true),
                startHost,
            }),
        ).resolves.toBe(true);

        expect(startHost).toHaveBeenCalledTimes(2);
        expect(onAttached).toHaveBeenCalledWith(true);
    });
});
