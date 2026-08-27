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

    async function createOutputDirectory(
        serverCore: string,
        extensionHost?: string,
        terminalHost?: string,
    ): Promise<string> {
        const created = await mkdtemp(join(tmpdir(), 'caxri-fingerprint-'));
        directory = created;
        await writeFile(join(created, 'server-core.js'), serverCore);
        if (extensionHost !== undefined)
            await writeFile(join(created, 'extension-host.js'), extensionHost);
        if (terminalHost !== undefined)
            await writeFile(join(created, 'terminal-host.js'), terminalHost);
        return created;
    }

    it('is stable for identical bundle bytes and changes when any owned process changes', async () => {
        const outputDirectory = await createOutputDirectory(
            'server-core-a',
            'extension-host-a',
            'terminal-host-a',
        );
        const first = await computeBuildFingerprint(outputDirectory);
        expect(first).toMatch(/^[0-9a-f]{16}$/);
        expect(await computeBuildFingerprint(outputDirectory)).toBe(first);

        await writeFile(join(outputDirectory, 'extension-host.js'), 'extension-host-b');
        const afterExtensionHostChange = await computeBuildFingerprint(outputDirectory);
        expect(afterExtensionHostChange).not.toBe(first);

        await writeFile(join(outputDirectory, 'terminal-host.js'), 'terminal-host-b');
        const afterTerminalHostChange = await computeBuildFingerprint(outputDirectory);
        expect(afterTerminalHostChange).not.toBe(afterExtensionHostChange);

        await writeFile(join(outputDirectory, 'server-core.js'), 'server-core-b');
        expect(await computeBuildFingerprint(outputDirectory)).not.toBe(afterTerminalHostChange);
    });

    it('returns undefined when a bundle is missing so callers skip the staleness comparison', async () => {
        const outputDirectory = await createOutputDirectory('server-core-a');
        expect(await computeBuildFingerprint(outputDirectory)).toBeUndefined();
    });
});
