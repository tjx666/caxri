import { describe, expect, it } from 'vitest';

import { resolveLogDirectory } from '../log-path';

describe('resolveLogDirectory', () => {
    it('writes development logs to the repository root', () => {
        expect(
            resolveLogDirectory({
                currentDirectory: '/project/out/main',
                isPackaged: false,
                rendererUrl: 'http://localhost:5173',
                userDataPath: '/user-data',
            }),
        ).toBe('/project/logs');
    });

    it('keeps packaged logs in Electron user data when a renderer URL is present', () => {
        expect(
            resolveLogDirectory({
                currentDirectory: '/application/out/main',
                isPackaged: true,
                rendererUrl: 'http://localhost:5173',
                userDataPath: '/user-data',
            }),
        ).toBe('/user-data/logs');
    });
});
