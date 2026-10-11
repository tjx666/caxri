import { Buffer } from 'node:buffer';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MobileImageStore } from '../image-store';

const roots: string[] = [];
afterEach(async () => {
    const pending = roots.slice();
    roots.length = 0;
    await Promise.all(pending.map((root) => rm(root, { recursive: true, force: true })));
});

describe('MobileImageStore', () => {
    it('creates no file until all chunks arrive and binds the image to one device and Session', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-mobile-image-test-'));
        roots.push(root);
        const store = new MobileImageStore(root);
        const image = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
        const first = image.subarray(0, 3).toString('base64');
        const second = image.subarray(3).toString('base64');
        const input = {
            attachmentId: `image_${'a'.repeat(32)}`,
            chunkCount: 2,
            owner: 'device:1',
            sessionId: 'session-one',
        };
        expect(await store.upload({ ...input, chunkIndex: 0, chunk: first })).toEqual({
            ready: false,
        });
        expect(await readdir(root)).toEqual([]);
        await expect(
            store.upload({ ...input, owner: 'device:2', chunkIndex: 1, chunk: second }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await store.upload({ ...input, chunkIndex: 1, chunk: second })).toEqual({
            ready: true,
        });
        expect(store.paths('device:1', 'session-one', [input.attachmentId])).toHaveLength(1);
        expect(() => store.paths('device:2', 'session-one', [input.attachmentId])).toThrow();
        expect(await store.read('device:1', 'session-one', [input.attachmentId])).toEqual([
            image.toString('base64'),
        ]);
        await expect(
            store.read('device:1', 'session-two', [input.attachmentId]),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects invalid content without leaving a temporary file', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-mobile-image-test-'));
        roots.push(root);
        const store = new MobileImageStore(root);
        await expect(
            store.upload({
                attachmentId: `image_${'b'.repeat(32)}`,
                chunkIndex: 0,
                chunkCount: 1,
                chunk: Buffer.from('plain text').toString('base64'),
                owner: 'device:1',
                sessionId: 'session-one',
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        expect(await readdir(root)).toEqual([]);
    });

    it('does not count retained complete images against pending upload capacity', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-mobile-image-test-'));
        roots.push(root);
        const store = new MobileImageStore(root);
        const chunk = Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64');
        for (let index = 0; index < 17; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- Each completed image must release the pending slot.
            await expect(
                store.upload({
                    attachmentId: `image_${index.toString(16).padStart(32, '0')}`,
                    chunkIndex: 0,
                    chunkCount: 1,
                    chunk,
                    owner: 'device:1',
                    sessionId: 'session-one',
                }),
            ).resolves.toEqual({ ready: true });
        }
        expect(await readdir(root)).toHaveLength(17);
    });
});
