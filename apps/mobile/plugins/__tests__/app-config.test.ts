import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { draculaTheme } from '@caxri/protocol';
import type { ConfigContext } from 'expo/config';
import { describe, expect, it } from 'vitest';

import createExpoConfig, { mobileVersionCode } from '../../app.config';
import mobilePackage from '../../package.json';

describe('mobile Expo config', () => {
    it('supplies branded launcher icons and a newer Android build for in-place upgrades', () => {
        const config = createExpoConfig({ config: {} } as ConfigContext);

        expect(config.version).toBe(mobilePackage.version);
        expect(config.icon).toBe('../../build/icon.png');
        expect(existsSync(resolve(import.meta.dirname, '../..', config.icon!))).toBe(true);
        expect(config.android?.versionCode).toBe(mobileVersionCode(mobilePackage.version));
        expect(config.android?.permissions).toContain(
            'android.permission.REQUEST_INSTALL_PACKAGES',
        );
        expect(config.android?.adaptiveIcon?.foregroundImage).toBe(config.icon);
        expect(config.android?.adaptiveIcon?.backgroundColor).toMatch(/^#[0-9a-f]{6}$/iu);
    });

    it('derives an ordered Android versionCode from the shared release version', () => {
        expect(mobileVersionCode('0.0.74')).toBe(74);
        expect(mobileVersionCode('0.1.0')).toBeGreaterThan(mobileVersionCode('0.0.999'));
        expect(mobileVersionCode('1.2.3')).toBe(1_002_003);
        expect(() => mobileVersionCode('1.2.3-beta.1')).toThrow(/major\.minor\.patch/u);
    });

    it('keeps the build-time splash color aligned with the runtime Dracula theme', () => {
        const config = createExpoConfig({ config: {} } as ConfigContext);

        expect(config.plugins).toContainEqual([
            'expo-splash-screen',
            {
                backgroundColor: draculaTheme.colors.background,
                image: '../../build/icon.png',
                imageWidth: 128,
            },
        ]);
    });
});
