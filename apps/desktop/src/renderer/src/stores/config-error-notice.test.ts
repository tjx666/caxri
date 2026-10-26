import { beforeEach, describe, expect, it, vi } from 'vitest';

const pushToast = vi.hoisted(() => vi.fn());
const dismissToastsMatching = vi.hoisted(() => vi.fn());
const getToasts = vi.hoisted(() => vi.fn(() => [] as Array<{ title: string }>));
vi.mock('./toasts', () => ({ pushToast, dismissToastsMatching, getToasts }));

import {
    CONFIG_ERROR_RESURFACE_MS,
    configErrorMessage as configErrorMessage,
    resetConfigErrorNoticeForTest as resetConfigErrorNoticeForTest,
    showConfigChangeError as showConfigChangeError,
    syncConfigErrorNotice as syncConfigErrorNotice,
} from './config-error-notice';

describe('configuration error notice', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getToasts.mockReturnValue([{ title: 'settings.jsonc: bad' }]);
        resetConfigErrorNoticeForTest();
    });

    it('shows a single error as is, since it already names its file', () => {
        expect(configErrorMessage(['settings.jsonc: bad token'])).toBe('settings.jsonc: bad token');
        expect(configErrorMessage([])).toBeUndefined();
    });

    it('leads with the count and names the first error when several exist', () => {
        expect(configErrorMessage(['settings.jsonc: bad', 'theme.json: worse'])).toBe(
            '2 configuration files have errors and their defaults are in use. First: settings.jsonc: bad',
        );
    });

    it('persists the notice with an Open Settings File action and does not repeat it', () => {
        syncConfigErrorNotice(['settings.jsonc: bad']);
        syncConfigErrorNotice(['settings.jsonc: bad']);
        expect(pushToast).toHaveBeenCalledTimes(1);
        expect(pushToast).toHaveBeenCalledWith('error', 'settings.jsonc: bad', {
            persist: true,
            action: { id: 'settings.openSource' },
        });
    });

    it('retracts the notice once the errors are gone', () => {
        syncConfigErrorNotice(['settings.jsonc: bad']);
        syncConfigErrorNotice([]);
        const [matcher] = dismissToastsMatching.mock.calls[0] as [(title: string) => boolean];
        expect(matcher('settings.jsonc: bad')).toBe(true);
        expect(matcher('other')).toBe(false);
        syncConfigErrorNotice([]);
        expect(dismissToastsMatching).toHaveBeenCalledTimes(1);
    });

    it('does not duplicate when a change event repeats the snapshot error', () => {
        showConfigChangeError('settings.jsonc: bad');
        syncConfigErrorNotice(['settings.jsonc: bad']);
        expect(pushToast).toHaveBeenCalledTimes(1);
    });

    it('brings the notice back after the user dismissed it and the cooldown passed', () => {
        syncConfigErrorNotice(['settings.jsonc: bad'], 0);
        getToasts.mockReturnValue([]);
        syncConfigErrorNotice(['settings.jsonc: bad'], CONFIG_ERROR_RESURFACE_MS - 1);
        expect(pushToast).toHaveBeenCalledTimes(1);
        syncConfigErrorNotice(['settings.jsonc: bad'], CONFIG_ERROR_RESURFACE_MS);
        expect(pushToast).toHaveBeenCalledTimes(2);
    });
});
