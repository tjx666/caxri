import { afterEach, describe, expect, it, vi } from 'vitest';

import { installSharedProfile } from '../../../lib/__tests__/local-storage-profile';

const STORAGE_KEY = 'caxri.settings.showAdvanced';

async function openStore() {
    vi.resetModules();
    return import('../settings-advanced-store');
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('settings advanced store', () => {
    it('restores the flag a previous launch saved', async () => {
        installSharedProfile(new Map([[STORAGE_KEY, 'true']]));
        const { useSettingsAdvancedStore } = await openStore();
        expect(useSettingsAdvancedStore.getState().showAdvanced).toBe(true);
    });

    it('follows a toggle made in another window without writing it back', async () => {
        const profile = installSharedProfile();
        const { setShowAdvancedSettings, useSettingsAdvancedStore } = await openStore();
        expect(useSettingsAdvancedStore.getState().showAdvanced).toBe(false);

        profile.entries.set(STORAGE_KEY, 'true');
        profile.fireStorageEvent(STORAGE_KEY);
        expect(useSettingsAdvancedStore.getState().showAdvanced).toBe(true);
        expect(profile.entries.get(STORAGE_KEY)).toBe('true');

        setShowAdvancedSettings(false);
        expect(profile.entries.get(STORAGE_KEY)).toBe('false');
    });
});
