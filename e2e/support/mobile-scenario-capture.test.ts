import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureScenarioFrame } from './mobile-scenario-capture';

vi.mock('./mobile-android', () => ({
    captureMobileFramebuffer: vi.fn(async (_serial: string, path: string) => {
        await writeFile(path, 'png');
    }),
}));

const directories: string[] = [];

afterEach(async () => {
    const created = [...directories];
    directories.length = 0;
    await Promise.all(created.map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('captureScenarioFrame', () => {
    it('keeps every earlier frame in the manifest when the scenario throws after a capture', async () => {
        const assetsDirectory = await mkdtemp(join(tmpdir(), 'caxri-scenario-capture-'));
        directories.push(assetsDirectory);
        const target = {
            artifactManifestPath: join(assetsDirectory, 'MOB-EXAMPLE-01-artifact-manifest.json'),
            assetsDirectory,
            caseId: 'MOB-EXAMPLE-01',
            serial: 'emulator-5554',
        };
        const artifacts: string[] = [];
        const scenario = async (): Promise<void> => {
            await captureScenarioFrame(target, 'before', artifacts);
            await captureScenarioFrame(target, 'holding', artifacts);
            throw new Error('old behavior');
        };

        await expect(scenario()).rejects.toThrow('old behavior');

        expect(JSON.parse(await readFile(target.artifactManifestPath, 'utf8'))).toEqual({
            artifacts: [
                'assets/MOB-EXAMPLE-01-before-android.png',
                'assets/MOB-EXAMPLE-01-holding-android.png',
            ],
            schemaVersion: 1,
        });
    });
});
