import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, constants, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareAlerter } from '../build-alerter';

const run = promisify(execFile);

describe.runIf(process.platform === 'darwin')('prepareAlerter', () => {
    let directory: string;
    let archive: Uint8Array;
    let archiveSha256: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'caxri-build-alerter-'));
        const source = join(directory, 'source');
        await mkdir(source);
        await writeFile(join(source, 'alerter'), '#!/bin/sh\necho alerter\n');
        await run('ditto', ['-c', '-k', source, join(directory, 'alerter.zip')]);
        archive = await readFile(join(directory, 'alerter.zip'));
        archiveSha256 = createHash('sha256').update(archive).digest('hex');
    });

    afterEach(async () => {
        await rm(directory, { force: true, recursive: true });
    });

    it('unpacks a verified archive as an executable and reuses the cached copy', async () => {
        const download = vi.fn(() => Promise.resolve(archive));
        const options = {
            cacheDirectory: join(directory, 'cache'),
            download,
            expectedSha256: archiveSha256,
            outputPath: join(directory, 'out', 'alerter'),
        };
        await prepareAlerter(options);
        await prepareAlerter(options);
        await expect(access(options.outputPath, constants.X_OK)).resolves.toBeUndefined();
        expect(download).toHaveBeenCalledOnce();
    });

    it('refuses an archive that does not match the pinned checksum and caches nothing', async () => {
        const options = {
            cacheDirectory: join(directory, 'cache'),
            download: () => Promise.resolve(archive),
            expectedSha256: '0'.repeat(64),
            outputPath: join(directory, 'out', 'alerter'),
        };
        await expect(prepareAlerter(options)).rejects.toThrow(/does not match its pinned SHA-256/);
        await expect(access(options.outputPath)).rejects.toThrow();
        await expect(access(options.cacheDirectory)).rejects.toThrow();
    });
});
