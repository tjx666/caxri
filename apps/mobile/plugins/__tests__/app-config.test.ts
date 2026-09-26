import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { draculaTheme } from '@caxri/protocol';
import type { ConfigContext } from 'expo/config';
import { describe, expect, it } from 'vitest';

import createExpoConfig from '../../app.config';
import mobilePackage from '../../package.json';

describe('mobile Expo config', () => {
    it('supplies branded launcher icons and a newer Android build for in-place upgrades', () => {
        const config = createExpoConfig({ config: {} } as ConfigContext);

        expect(config.version).toBe(mobilePackage.version);
        expect(config.icon).toBe('../../build/icon.png');
        expect(existsSync(resolve(import.meta.dirname, '../..', config.icon!))).toBe(true);
        expect(config.android?.versionCode).toBeGreaterThan(1);
        expect(config.android?.adaptiveIcon?.foregroundImage).toBe(config.icon);
        expect(config.android?.adaptiveIcon?.backgroundColor).toMatch(/^#[0-9a-f]{6}$/iu);
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
