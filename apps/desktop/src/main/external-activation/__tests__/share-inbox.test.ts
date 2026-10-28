import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    electShareExtension,
    pruneShareInbox,
    readShareRequest,
    SHARE_EXTENSION_BUNDLE_ID,
    SHARE_REQUEST_FILE_NAME,
} from '../share-inbox';

const REQUEST_ID = '0f3c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
const OTHER_REQUEST_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const fixture = { root: '', inbox: '' };

beforeEach(async () => {
    // `tmpdir()` is a symlink on macOS; the reader resolves real paths.
    const created = await mkdtemp(join(tmpdir(), 'caxri-share-inbox-'));
    fixture.root = await realpath(created);
    fixture.inbox = join(fixture.root, 'Share Inbox');
    await mkdir(fixture.inbox);
});

afterEach(async () => {
    await rm(fixture.root, { force: true, recursive: true });
});

async function writeRequest(
    manifest: unknown,
    files: Record<string, string> = {},
    requestId = REQUEST_ID,
): Promise<string> {
    const folder = join(fixture.inbox, requestId);
    await mkdir(folder, { recursive: true });
    await Promise.all(
        Object.entries(files).map(([name, contents]) => writeFile(join(folder, name), contents)),
    );
    const manifestPath = join(folder, SHARE_REQUEST_FILE_NAME);
    await writeFile(manifestPath, JSON.stringify(manifest));
    return manifestPath;
}

describe('readShareRequest', () => {
    it('accepts a manifest whose files are entries of its own request folder', async () => {
        const manifestPath = await writeRequest(
            { version: 1, files: ['chat.zip'], text: 'Summarize this' },
            { 'chat.zip': 'zip' },
        );

        await expect(readShareRequest(manifestPath, fixture.inbox)).resolves.toEqual({
            requestId: REQUEST_ID,
            files: [{ path: join(fixture.inbox, REQUEST_ID, 'chat.zip'), isDirectory: false }],
            text: 'Summarize this',
        });
    });

    it('accepts shared text without files', async () => {
        const manifestPath = await writeRequest({
            version: 1,
            files: [],
            text: 'https://example.com',
        });

        await expect(readShareRequest(manifestPath, fixture.inbox)).resolves.toMatchObject({
            files: [],
            text: 'https://example.com',
        });
    });

    it('rejects a manifest outside the Share Inbox', async () => {
        const elsewhere = join(fixture.root, REQUEST_ID);
        await mkdir(elsewhere);
        const manifestPath = join(elsewhere, SHARE_REQUEST_FILE_NAME);
        await writeFile(manifestPath, JSON.stringify({ version: 1, files: [] }));

        await expect(readShareRequest(manifestPath, fixture.inbox)).rejects.toMatchObject({
            reason: 'outside-inbox',
        });
    });

    it('rejects a document that is not a share request manifest', async () => {
        await expect(
            readShareRequest(join(fixture.inbox, 'notes.txt'), fixture.inbox),
        ).rejects.toMatchObject({
            reason: 'not-a-request',
        });
    });

    it('rejects a request folder that is not named by a request id', async () => {
        const manifestPath = await writeRequest({ version: 1, files: [] }, {}, 'not-an-id');

        await expect(readShareRequest(manifestPath, fixture.inbox)).rejects.toMatchObject({
            reason: 'outside-inbox',
        });
    });

    it('rejects a file name that leaves the request folder', async () => {
        const manifestPath = await writeRequest({ version: 1, files: ['../secret'] });

        await expect(readShareRequest(manifestPath, fixture.inbox)).rejects.toMatchObject({
            reason: 'unsafe-file-name',
        });
    });

    it('rejects a symlink placed in the request folder', async () => {
        const manifestPath = await writeRequest({ version: 1, files: ['link'] });
        await symlink(join(fixture.root, 'outside'), join(fixture.inbox, REQUEST_ID, 'link'));

        await expect(readShareRequest(manifestPath, fixture.inbox)).rejects.toMatchObject({
            reason: 'missing-file',
        });
    });

    it('rejects a manifest that is not the expected shape', async () => {
        const manifestPath = await writeRequest({ version: 2, files: [] });

        await expect(readShareRequest(manifestPath, fixture.inbox)).rejects.toMatchObject({
            reason: 'invalid-manifest',
        });
    });

    it('rejects a request that carries nothing', async () => {
        const manifestPath = await writeRequest({ version: 1, files: [] });

        await expect(readShareRequest(manifestPath, fixture.inbox)).rejects.toMatchObject({
            reason: 'empty',
        });
    });
});

describe('pruneShareInbox', () => {
    it('removes only request folders older than the retention period', async () => {
        await writeRequest({ version: 1, files: [] }, {}, REQUEST_ID);
        await writeRequest({ version: 1, files: [] }, {}, OTHER_REQUEST_ID);
        await mkdir(join(fixture.inbox, 'unrelated'));
        const now = Date.now();
        const old = new Date(now - 10_000);
        await utimes(join(fixture.inbox, REQUEST_ID), old, old);

        await expect(pruneShareInbox(fixture.inbox, now, 5000)).resolves.toEqual({
            removed: 1,
            failed: 0,
        });
        await expect(
            readShareRequest(
                join(fixture.inbox, REQUEST_ID, SHARE_REQUEST_FILE_NAME),
                fixture.inbox,
            ),
        ).rejects.toMatchObject({
            reason: 'unreadable',
        });
    });

    it('treats a missing inbox as nothing to prune', async () => {
        await expect(pruneShareInbox(join(fixture.root, 'missing'), Date.now())).resolves.toEqual({
            removed: 0,
            failed: 0,
        });
    });
});

describe('electShareExtension', () => {
    function pluginkit(listing: string) {
        return vi.fn((_file: string, arguments_: string[]) =>
            Promise.resolve({ stdout: arguments_[0] === '-m' ? listing : '' }),
        );
    }

    it('enables an extension the user never chose either way', async () => {
        const run = pluginkit(`     ${SHARE_EXTENSION_BUNDLE_ID}(0.0.141)\n`);

        await expect(electShareExtension(run)).resolves.toBe('enabled');
        expect(run).toHaveBeenCalledWith('pluginkit', [
            '-e',
            'use',
            '-i',
            SHARE_EXTENSION_BUNDLE_ID,
        ]);
    });

    it.each(['+', '-'])('keeps the election the user made (%s)', async (mark) => {
        const run = pluginkit(`${mark}    ${SHARE_EXTENSION_BUNDLE_ID}(0.0.141)\n`);

        await expect(electShareExtension(run)).resolves.toBe('already-elected');
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('reports an extension the system has not registered', async () => {
        await expect(electShareExtension(pluginkit('(no matches)\n'))).resolves.toBe(
            'not-registered',
        );
    });
});
