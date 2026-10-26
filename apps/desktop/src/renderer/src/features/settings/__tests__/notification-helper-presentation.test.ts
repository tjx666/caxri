import { describe, expect, it } from 'vitest';

import { presentNotificationHelper } from '../notification-helper-presentation';

describe('notification helper presentation', () => {
    it('states a working helper without install instructions', () => {
        expect(presentNotificationHelper('helper')).toEqual({
            headlineKey: 'settings.notificationHelper.status.helper',
            isInstallShown: false,
            tone: 'muted',
        });
    });

    it('states signed-build delivery without a warning', () => {
        expect(presentNotificationHelper('native')).toMatchObject({
            headlineKey: 'settings.notificationHelper.status.native',
            isInstallShown: false,
            tone: 'muted',
        });
    });

    it('asks for the helper and names the basic fallback', () => {
        expect(presentNotificationHelper('basic')).toEqual({
            headlineKey: 'settings.notificationHelper.status.basic',
            isInstallShown: true,
            noteKey: 'settings.notificationHelper.note.basic',
            tone: 'warning',
        });
    });

    it('says plainly that banners cannot be shown when even the fallback failed', () => {
        expect(presentNotificationHelper('unavailable')).toMatchObject({
            isInstallShown: true,
            noteKey: 'settings.notificationHelper.note.unavailable',
        });
    });
});
