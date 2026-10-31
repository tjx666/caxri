import type { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const installScript = resolve(import.meta.dirname, '../../install.sh');
const VERSION = '9.9.9';
const DMG = `Caxri-${VERSION}-arm64.dmg`;

interface InstallResult {
    code: number;
    stderr: string;
    stdout: string;
}

/**
 * Drives the public `install.sh` against a synthetic release served from localhost: a real DMG built with `hdiutil`,
 * its checksum, and GitHub's `releases/latest` redirect. Only Apple Silicon Macs can run it, as the script refuses
 * every other platform before downloading.
 */
describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')('install.sh', () => {
    let directory: string;
    let dmg: Buffer;
    let server: Server;
    let releaseUrl: string;
    let checksum = '';

    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'caxri-install-script-'));
        const app = join(directory, 'image', 'Caxri.app', 'Contents', 'MacOS');
        await mkdir(app, { recursive: true });
        await writeFile(join(app, 'Caxri'), `release ${VERSION}\n`);
        await run('hdiutil', [
            'create',
            '-quiet',
            '-fs',
            'HFS+',
            '-volname',
            'Caxri',
            '-srcfolder',
            join(directory, 'image'),
            join(directory, DMG),
        ]);
        dmg = await readFile(join(directory, DMG));
        server = createServer((request, response) => {
            const path = request.url ?? '';
            switch (path) {
                case '/releases/latest': {
                    response.writeHead(302, { location: `/releases/tag/v${VERSION}` }).end();

                    break;
                }
                case `/releases/tag/v${VERSION}`: {
                    response.writeHead(200).end('release page');

                    break;
                }
                case `/releases/download/v${VERSION}/${DMG}`: {
                    response.writeHead(200).end(dmg);

                    break;
                }
                case `/releases/download/v${VERSION}/${DMG}.sha256`: {
                    response.writeHead(200).end(`${checksum}  ${DMG}\n`);

                    break;
                }
                default: {
                    response.writeHead(404).end();
                }
            }
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        releaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases`;
    }, 60_000);

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        await rm(directory, { force: true, recursive: true });
    });

    async function install(installDirectory: string): Promise<InstallResult> {
        try {
            const { stderr, stdout } = await run('/bin/bash', [installScript], {
                env: {
                    ...process.env,
                    CAXRI_INSTALL_DIR: installDirectory,
                    CAXRI_RELEASE_URL: releaseUrl,
                    CAXRI_VERSION: '',
                },
            });
            return { code: 0, stderr, stdout };
        } catch (error) {
            const failed = error as { code: number; stderr: string; stdout: string };
            return { code: failed.code, stderr: failed.stderr, stdout: failed.stdout };
        }
    }

    async function installedRelease(installDirectory: string): Promise<string> {
        return readFile(join(installDirectory, 'Caxri.app', 'Contents', 'MacOS', 'Caxri'), 'utf8');
    }

    async function withPreviousApp(name: string): Promise<string> {
        const installDirectory = join(directory, name);
        const previous = join(installDirectory, 'Caxri.app', 'Contents', 'MacOS');
        await mkdir(previous, { recursive: true });
        await writeFile(join(previous, 'Caxri'), 'release 1.0.0\n');
        return installDirectory;
    }

    it('installs the latest release over the previous app and leaves no staging copies', async () => {
        checksum = createHash('sha256').update(dmg).digest('hex');
        const installDirectory = await withPreviousApp('update');

        const result = await install(installDirectory);

        expect(result.stderr).not.toMatch(/install failed/);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`Installed Caxri ${VERSION}`);
        await expect(installedRelease(installDirectory)).resolves.toBe(`release ${VERSION}\n`);
        await expect(
            readFile(join(installDirectory, '.Caxri.app.previous', 'Contents', 'MacOS', 'Caxri')),
        ).rejects.toThrow();
    }, 60_000);

    it('refuses a download that does not match its published checksum and keeps the previous app', async () => {
        checksum = '0'.repeat(64);
        const installDirectory = await withPreviousApp('mismatch');

        const result = await install(installDirectory);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('does not match its published SHA-256');
        expect(result.stderr).toContain('Nothing was installed');
        await expect(installedRelease(installDirectory)).resolves.toBe('release 1.0.0\n');
    }, 60_000);

    it('names the missing folder instead of creating one', async () => {
        checksum = createHash('sha256').update(dmg).digest('hex');

        const result = await install(join(directory, 'missing'));

        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`${join(directory, 'missing')} does not exist`);
    });
});
