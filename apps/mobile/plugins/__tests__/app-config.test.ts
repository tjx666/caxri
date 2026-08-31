import { draculaTheme } from '@caxri/protocol';
import type { ConfigContext } from 'expo/config';
import { describe, expect, it } from 'vitest';

import createExpoConfig from '../../app.config';

describe('mobile Expo config', () => {
    it('keeps the build-time splash color aligned with the runtime Dracula theme', () => {
        const config = createExpoConfig({ config: {} } as ConfigContext);

        expect(config.plugins).toContainEqual([
            'expo-splash-screen',
            { backgroundColor: draculaTheme.colors.background },
        ]);
    });
});
