import { describe, expect, it } from 'vitest';

import { resolveLogDirectory } from '../log-path';

describe('resolveLogDirectory', () => {
    it('writes development logs to the repository root', () => {
        expect(
            resolveLogDirectory({
                currentDirectory: '/project/out/main',
                rendererUrl: 'http://localhost:5173',
                userDataPath: '/user-data',
            }),
        ).toBe('/project/logs');
    });

    it('keeps packaged and test logs in Electron user data', () => {
        expect(
            resolveLogDirectory({
                currentDirectory: '/application/out/main',
                userDataPath: '/user-data',
            }),
        ).toBe('/user-data/logs');
    });
});
