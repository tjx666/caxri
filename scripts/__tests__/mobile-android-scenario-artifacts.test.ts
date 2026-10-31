import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { bindAndroidScenarioArtifacts } from '../mobile-android-scenario-artifacts';

const VALID_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);
const CASE_ID = 'MOB-CHAT-EXAMPLE-01';
const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

async function reportDirectoryWith(manifest?: unknown): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-scenario-artifacts-'));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, 'assets'));
    if (manifest !== undefined) {
        await writeFile(
            join(directory, 'assets', `${CASE_ID}-artifact-manifest.json`),
            JSON.stringify(manifest),
        );
    }
    return directory;
}

describe('bindAndroidScenarioArtifacts', () => {
    it('binds every screenshot the manifest names, in manifest order', async () => {
        const directory = await reportDirectoryWith({
            artifacts: [`assets/${CASE_ID}-before.png`, `assets/${CASE_ID}-after.png`],
            schemaVersion: 1,
        });
        await writeFile(join(directory, 'assets', `${CASE_ID}-before.png`), VALID_PNG);
        await writeFile(join(directory, 'assets', `${CASE_ID}-after.png`), VALID_PNG);

        const artifacts = await bindAndroidScenarioArtifacts(directory, CASE_ID);

        expect(artifacts.map(({ path, source, type }) => ({ path, source, type }))).toEqual([
            {
                path: `assets/${CASE_ID}-before.png`,
                source: 'android-framebuffer',
                type: 'screenshot',
            },
            {
                path: `assets/${CASE_ID}-after.png`,
                source: 'android-framebuffer',
                type: 'screenshot',
            },
        ]);
        expect(artifacts.every(({ sha256 }) => /^[\da-f]{64}$/u.test(sha256))).toBe(true);
    });

    it('binds nothing when the scenario wrote no manifest', async () => {
        await expect(
            bindAndroidScenarioArtifacts(await reportDirectoryWith(), CASE_ID),
        ).resolves.toEqual([]);
    });

    it("rejects a manifest naming another case's screenshot", async () => {
        const directory = await reportDirectoryWith({
            artifacts: ['assets/MOB-CHAT-OTHER-01-before.png'],
            schemaVersion: 1,
        });

        await expect(bindAndroidScenarioArtifacts(directory, CASE_ID)).rejects.toThrow(
            'Android scenario artifact manifest is invalid',
        );
    });
});
