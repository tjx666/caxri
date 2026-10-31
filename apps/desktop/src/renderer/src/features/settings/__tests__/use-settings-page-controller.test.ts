import type { ArgvConfig } from '@caxri/protocol';
import { argvConfigSchema, CaxriError } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dismissToast, getToasts } from '../../../stores/toasts';
import {
    argvRestartNotice,
    argvRestartNoticePrefix,
    settingTitleForArgvKey,
} from '../argv-restart-notice';
import { reportSettingsError } from '../settings-error-report';

const BOOT_BASELINE: ArgvConfig = { hardwareAcceleration: true, remoteDebugging: true };

describe('settingTitleForArgvKey', () => {
    it('resolves every boot flag to the Settings row title the user actually reads', () => {
        for (const key of Object.keys(argvConfigSchema.shape) as Array<keyof ArgvConfig>)
            expect(settingTitleForArgvKey(key)).toBeTypeOf('string');
    });

    it('returns the registry title rather than the flag name', () => {
        expect(settingTitleForArgvKey('hardwareAcceleration')).toBe('Hardware acceleration');
        expect(settingTitleForArgvKey('remoteDebugging')).toBe('Debugging port');
    });
});

describe('argvRestartNotice', () => {
    it('names the setting the user just changed and what to do about it', () => {
        expect(
            argvRestartNotice({
                applied: { ...BOOT_BASELINE, hardwareAcceleration: false },
                baseline: BOOT_BASELINE,
            }),
        ).toBe('Restart Caxri to apply the new hardware acceleration setting.');
    });

    it('keeps an acronym in the title capitalized inside the sentence', () => {
        expect(
            argvRestartNotice({
                applied: { ...BOOT_BASELINE, remoteDebugging: false },
                baseline: BOOT_BASELINE,
            }),
        ).toBe('Restart Caxri to apply the new debugging port setting.');
    });

    it('uses no implementation vocabulary for the file the write lands in', () => {
        const notice = argvRestartNotice({
            applied: { ...BOOT_BASELINE, hardwareAcceleration: false },
            baseline: BOOT_BASELINE,
        });
        expect(notice).not.toMatch(/boot|argv|config/i);
    });

    it('stays silent while the boot baseline is still loading', () => {
        expect(
            argvRestartNotice({
                applied: { ...BOOT_BASELINE, hardwareAcceleration: false },
                baseline: undefined,
            }),
        ).toBeUndefined();
    });

    it('stays silent when the write returns the flag to what the instance launched with', () => {
        expect(
            argvRestartNotice({ applied: BOOT_BASELINE, baseline: BOOT_BASELINE }),
        ).toBeUndefined();
    });

    /**
     * The notice is one replaceable card, so it has to describe every pending flag rather than the latest write. Naming
     * only the flag just touched would retract a restart the user still owes for an earlier row.
     */
    it('names every flag still pending, not only the one the latest write touched', () => {
        expect(
            argvRestartNotice({
                applied: { hardwareAcceleration: false, remoteDebugging: false },
                baseline: BOOT_BASELINE,
            }),
        ).toBe('Restart Caxri to apply the new hardware acceleration and debugging port settings.');
    });

    it('drops a flag back out of the sentence once it returns to its launch value', () => {
        expect(
            argvRestartNotice({
                applied: { hardwareAcceleration: true, remoteDebugging: false },
                baseline: BOOT_BASELINE,
            }),
        ).toBe('Restart Caxri to apply the new debugging port setting.');
    });

    /**
     * The toast retracts its own previous wording by prefix, so every sentence this builds has to carry it.
     */
    it('always opens with the prefix the toast retracts on', () => {
        for (const applied of [
            { hardwareAcceleration: false, remoteDebugging: true },
            { hardwareAcceleration: true, remoteDebugging: false },
            { hardwareAcceleration: false, remoteDebugging: false },
        ])
            expect(argvRestartNotice({ applied, baseline: BOOT_BASELINE })).toMatch(
                new RegExp(`^${argvRestartNoticePrefix()}`),
            );
    });
});

describe('reportSettingsError', () => {
    beforeEach(() => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
            setTimeout(callback, 0),
        );
        vi.stubGlobal('cancelAnimationFrame', clearTimeout);
        dismissToast();
    });

    afterEach(() => {
        dismissToast();
        vi.unstubAllGlobals();
    });

    it('names the file whose write failed', () => {
        reportSettingsError(new CaxriError('IO', 'disk full'), 'settings.jsonc');
        expect(getToasts().map((toast) => toast.title)).toEqual(['settings.jsonc. disk full.']);
    });

    it('stays silent for a write Main cancelled because the app is quitting', () => {
        reportSettingsError(
            new CaxriError('CANCELLED', 'Application is quitting'),
            'settings.jsonc',
        );
        expect(getToasts()).toEqual([]);
    });
});
