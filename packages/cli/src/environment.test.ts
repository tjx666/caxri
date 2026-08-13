import { describe, expect, it } from 'vitest';

import { resolveCliProfile } from './environment';

describe('CLI profile resolution', () => {
    it('uses the explicit selector before the shared profile environment', () => {
        expect(
            resolveCliProfile({
                environment: { CAXRI_USER_DATA_DIR: '/profiles/environment' },
                explicit: '/profiles/argument',
                home: '/Users/test',
                platform: 'darwin',
            }),
        ).toEqual({ path: '/profiles/argument', source: 'argument' });
    });

    it('derives non-macOS defaults only from the injected environment', () => {
        expect(
            resolveCliProfile({
                environment: { XDG_CONFIG_HOME: '/xdg/config' },
                home: '/home/test',
                platform: 'linux',
            }),
        ).toEqual({ path: '/xdg/config/Caxri', source: 'default' });
    });

    it('rejects relative selectors instead of resolving them against the shell directory', () => {
        expect(() =>
            resolveCliProfile({
                environment: { CAXRI_USER_DATA_DIR: 'relative/profile' },
                home: '/Users/test',
                platform: 'darwin',
            }),
        ).toThrow('must be an absolute path');
    });
});
