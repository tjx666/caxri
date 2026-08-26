import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { computeBuildFingerprint } from '../fingerprint';

describe('computeBuildFingerprint', () => {
    let directory: string | undefined;

    afterEach(async () => {
        if (directory) await rm(directory, { recursive: true, force: true });
        directory = undefined;
    });

    async function createOutputDirectory(host: string, runtime?: string): Promise<string> {
        const created = await mkdtemp(join(tmpdir(), 'caxri-fingerprint-'));
        directory = created;
        await writeFile(join(created, 'host.js'), host);
        if (runtime !== undefined) await writeFile(join(created, 'runtime.js'), runtime);
        return created;
    }

    it('is stable for identical bundle bytes and changes when either bundle changes', async () => {
        const outputDirectory = await createOutputDirectory('host-a', 'runtime-a');
        const first = await computeBuildFingerprint(outputDirectory);
        expect(first).toMatch(/^[0-9a-f]{16}$/);
        expect(await computeBuildFingerprint(outputDirectory)).toBe(first);

        await writeFile(join(outputDirectory, 'runtime.js'), 'runtime-b');
        const afterRuntimeChange = await computeBuildFingerprint(outputDirectory);
        expect(afterRuntimeChange).not.toBe(first);

        await writeFile(join(outputDirectory, 'host.js'), 'host-b');
        expect(await computeBuildFingerprint(outputDirectory)).not.toBe(afterRuntimeChange);
    });

    it('returns undefined when a bundle is missing so callers skip the staleness comparison', async () => {
        const outputDirectory = await createOutputDirectory('host-a');
        expect(await computeBuildFingerprint(outputDirectory)).toBeUndefined();
    });
});
