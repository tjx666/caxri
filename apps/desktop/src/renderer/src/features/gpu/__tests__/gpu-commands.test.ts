import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve(undefined)),
    openSettings: vi.fn(),
    showConfirm: vi.fn((): Promise<boolean> => Promise.resolve(false)),
    /**
     * Mirrors the real `tryCommand`: it swallows the rejection after reporting it, so the caller never has to.
     */
    tryCommand: vi.fn(async (...[, run]: [string, () => Promise<unknown>]): Promise<unknown> => {
        try {
            return await run();
        } catch {
            return undefined;
        }
    }),
}));

vi.mock('../../../lib/caxri', () => ({
    caxri: { request: mocks.caxriRequest, window: { showConfirm: mocks.showConfirm } },
}));
vi.mock('../../../stores/dialogs', () => ({ openSettings: mocks.openSettings }));
vi.mock('../../../stores/toasts', () => ({ tryCommand: mocks.tryCommand }));

import {
    confirmTurnOffHardwareAcceleration,
    openHardwareAccelerationSettings,
    turnOffHardwareAccelerationConfirm,
} from '../gpu-commands';

beforeEach(() => {
    mocks.caxriRequest.mockClear();
    mocks.openSettings.mockClear();
    mocks.showConfirm.mockClear();
    mocks.tryCommand.mockClear();
});

describe('confirmTurnOffHardwareAcceleration', () => {
    it('asks before anything is written, and writes nothing when the answer is no', async () => {
        mocks.showConfirm.mockResolvedValueOnce(false);

        await confirmTurnOffHardwareAcceleration();

        expect(mocks.showConfirm).toHaveBeenCalledOnce();
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
    });

    it('requests the restart only after the user confirmed, and only once', async () => {
        const calls: string[] = [];
        mocks.showConfirm.mockImplementationOnce(() => {
            calls.push('confirm');
            return Promise.resolve(true);
        });
        mocks.caxriRequest.mockImplementationOnce(() => {
            calls.push('restart');
            return Promise.resolve(undefined);
        });

        await confirmTurnOffHardwareAcceleration();

        expect(calls).toEqual(['confirm', 'restart']);
        expect(mocks.caxriRequest).toHaveBeenCalledExactlyOnceWith('gpu.restartInSafeMode');
    });

    /**
     * The three facts the previous one-click action never stated. Asserted on the copy itself because the whole defect
     * was a button and a card describing different actions.
     */
    it('states that the change persists, that it restarts now, and where it is undone', () => {
        expect(turnOffHardwareAccelerationConfirm().title).toContain('restart Caxri?');
        expect(turnOffHardwareAccelerationConfirm().message).toContain('restarts now');
        expect(turnOffHardwareAccelerationConfirm().message).toContain('every time it starts');
        expect(turnOffHardwareAccelerationConfirm().message).toContain('back on in Settings');
    });

    it('keeps implementation vocabulary out of every string the user reads', () => {
        const copy = Object.values(turnOffHardwareAccelerationConfirm()).join(' ');
        for (const jargon of ['argv', 'WebGL', 'DOM', 'Safe Mode', 'disable-hardware-acceleration'])
            expect(copy).not.toContain(jargon);
    });
});

describe('openHardwareAccelerationSettings', () => {
    it('opens Settings on the row that owns the boot flag', () => {
        openHardwareAccelerationSettings();

        expect(mocks.openSettings).toHaveBeenCalledExactlyOnceWith('hardware-acceleration');
    });
});
