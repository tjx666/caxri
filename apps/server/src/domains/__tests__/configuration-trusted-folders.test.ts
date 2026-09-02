// eslint-disable-next-line unicorn/name-replacements -- Vitest contract uses this exact suite naming convention.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigService } from '../config';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('ConfigurationService trusted folders', () => {
    it('atomically adds a normalized trusted folder without discarding Settings comments', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-trusted-folders-'));
        temporaryDirectories.push(directory);
        const service = new ConfigService(directory, () => {});
        await service.initialize();
        const source = `{
  // Keep this explanation when Main trusts a folder.
  "terminal.fontSize": 15,
}
`;
        await service.updateSettings(source);

        await service.trustFolder('/Users/me/.lobehub/');
        await service.trustFolder('/Users/me/.lobehub');

        expect(service.getSettings().value['security.trustedFolders']).toEqual([
            '/Users/me/.lobehub',
        ]);
        expect(await readFile(service.settingsPath, 'utf8')).toContain(
            '// Keep this explanation when Main trusts a folder.',
        );
        expect(await readFile(service.settingsPath, 'utf8')).toContain(
            '"security.trustedFolders": [',
        );

        const before = service.getSettings();
        await expect(service.trustFolder('relative/path')).rejects.toThrow(
            'Invalid trusted folder',
        );
        expect(service.getSettings()).toEqual(before);
        await service.close();
    });
});
