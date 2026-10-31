import { Buffer } from 'node:buffer';
import * as fs from 'node:fs/promises';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { MAX_MOBILE_FILE_BYTES, MOBILE_FILE_CHUNK_BYTES } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MobileFileStore } from '../file-store';

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof fs>();
    return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
afterEach(async () => {
    const pending = roots.slice();
    roots.length = 0;
    await Promise.all(pending.map((root) => rm(root, { recursive: true, force: true })));
});

const newStore = async () => {
    const root = await mkdtemp(join(tmpdir(), 'caxri-mobile-file-test-'));
    roots.push(root);
    return { root, store: new MobileFileStore(root) };
};

const chunksOf = (bytes: Buffer): string[] => {
    const chunks: string[] = [];
    for (let start = 0; start < bytes.length; start += MOBILE_FILE_CHUNK_BYTES)
        chunks.push(bytes.subarray(start, start + MOBILE_FILE_CHUNK_BYTES).toString('base64'));
    return chunks.length === 0 ? [''] : chunks;
};

const attachmentId = (digit: string) => `file_${digit.repeat(32)}`;

describe('MobileFileStore', () => {
    it('assembles chunks sent out of order into a file under its own name', async () => {
        const { root, store } = await newStore();
        const bytes = Buffer.alloc(MOBILE_FILE_CHUNK_BYTES * 2 + 5, 7);
        bytes.write('%PDF', 0);
        bytes.write('tail!', MOBILE_FILE_CHUNK_BYTES * 2);
        const chunks = chunksOf(bytes);
        const input = {
            attachmentId: attachmentId('a'),
            name: 'Quarterly report.pdf',
            owner: 'device:1',
            sessionId: 'session-one',
            size: bytes.length,
        };
        expect(await store.upload({ ...input, chunkIndex: 2, chunk: chunks[2] })).toEqual({
            ready: false,
        });
        expect(await store.upload({ ...input, chunkIndex: 0, chunk: chunks[0] })).toEqual({
            ready: false,
        });
        // A chunk resent after an uncertain reply is accepted once.
        expect(await store.upload({ ...input, chunkIndex: 0, chunk: chunks[0] })).toEqual({
            ready: false,
        });
        expect(() => store.paths('device:1', 'session-one', [input.attachmentId])).toThrow();
        const { path } = await store.upload({ ...input, chunkIndex: 1, chunk: chunks[1] });
        expect(store.paths('device:1', 'session-one', [input.attachmentId])).toEqual([path]);
        expect(basename(path!)).toBe('Quarterly report.pdf');
        expect(dirname(dirname(path!))).toBe(root);
        expect(await readFile(path!)).toEqual(bytes);
        expect(await readdir(root)).toEqual([input.attachmentId]);
    });

    it('binds a file to the device and Session that uploaded it', async () => {
        const { store } = await newStore();
        const input = {
            attachmentId: attachmentId('b'),
            name: 'voice.m4a',
            owner: 'device:1',
            sessionId: 'session-one',
            size: 3,
        };
        const chunk = Buffer.from('abc').toString('base64');
        await expect(
            store.upload({ ...input, owner: 'device:2', chunkIndex: 0, chunk: 'YWI=' }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        expect(await store.upload({ ...input, chunkIndex: 0, chunk })).toMatchObject({
            ready: true,
        });
        expect(() => store.paths('device:2', 'session-one', [input.attachmentId])).toThrow(
            expect.objectContaining({ code: 'NOT_FOUND' }),
        );
        expect(() => store.paths('device:1', 'session-two', [input.attachmentId])).toThrow(
            expect.objectContaining({ code: 'NOT_FOUND' }),
        );
        await expect(
            store.upload({ ...input, name: 'other.m4a', chunkIndex: 0, chunk }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('accepts an empty file as one empty chunk', async () => {
        const { store } = await newStore();
        const input = {
            attachmentId: attachmentId('c'),
            name: 'empty.txt',
            owner: 'device:1',
            sessionId: 'session-one',
            size: 0,
        };
        const { path } = await store.upload({ ...input, chunkIndex: 0, chunk: '' });
        expect(await readFile(path!)).toHaveLength(0);
    });

    it('refuses an oversized file, a bad name, and a chunk of the wrong length without writing', async () => {
        const { root, store } = await newStore();
        const base = { owner: 'device:1', sessionId: 'session-one', chunkIndex: 0 };
        await expect(
            store.upload({
                ...base,
                attachmentId: attachmentId('d'),
                name: 'movie.mov',
                size: MAX_MOBILE_FILE_BYTES + 1,
                chunk: 'YWJj',
            }),
        ).rejects.toMatchObject({ code: 'CAPACITY' });
        await expect(
            store.upload({
                ...base,
                attachmentId: attachmentId('d'),
                name: '../escape',
                size: 3,
                chunk: 'YWJj',
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        await expect(
            store.upload({
                ...base,
                attachmentId: attachmentId('d'),
                name: 'short.bin',
                size: MOBILE_FILE_CHUNK_BYTES + 1,
                chunk: 'YWJj',
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        expect(await readdir(root)).toEqual([]);
    });

    it('discards an upload whose chunk the disk only partly wrote', async () => {
        const { root, store } = await newStore();
        const bytes = Buffer.alloc(16, 3);
        const realOpen = vi.mocked(fs.open).getMockImplementation()!;
        vi.mocked(fs.open).mockImplementationOnce(async (...arguments_) => {
            const handle = await realOpen(...arguments_);
            // A nearly full disk accepts fewer bytes than asked without throwing.
            handle.write = (() => Promise.resolve({ bytesWritten: 4, buffer: bytes })) as never;
            return handle;
        });
        await expect(
            store.upload({
                attachmentId: attachmentId('d'),
                name: 'clip.mp4',
                owner: 'device:1',
                sessionId: 'session-one',
                size: bytes.length,
                chunkIndex: 0,
                chunk: bytes.toString('base64'),
            }),
        ).rejects.toMatchObject({ code: 'INTERNAL' });
        expect(() => store.paths('device:1', 'session-one', [attachmentId('d')])).toThrow();
        await vi.waitFor(async () => expect(await readdir(root)).toEqual([]));
    });
    const uploadTiny = async (store: MobileFileStore, id: string) => {
        const { path } = await store.upload({
            attachmentId: id,
            name: 'a.txt',
            owner: 'device:1',
            sessionId: 'session-one',
            size: 1,
            chunkIndex: 0,
            chunk: Buffer.from('a').toString('base64'),
        });
        return path!;
    };
    const idOf = (index: number) => `file_${index.toString(16).padStart(32, '0')}`;

    it('keeps a cited file past its hour but deletes an uncited one', async () => {
        const { store } = await newStore();
        // Installed before the uploads so their expiry timers are the fake ones.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        let uncited: string;
        try {
            const cited = await uploadTiny(store, idOf(1));
            uncited = await uploadTiny(store, idOf(2));
            expect(store.paths('device:1', 'session-one', [idOf(1)])).toEqual([cited]);
            vi.advanceTimersByTime(3 * 60 * 60_000);
            expect(store.paths('device:1', 'session-one', [idOf(1)])).toEqual([cited]);
            expect(() => store.paths('device:1', 'session-one', [idOf(2)])).toThrow();
        } finally {
            vi.useRealTimers();
        }
        const root = dirname(dirname(uncited));
        await vi.waitFor(async () => {
            const entries = await readdir(root);
            expect(entries).toEqual([idOf(1)]);
        });
    });

    it('frees the quota of cited files and evicts the oldest only when the room is needed', async () => {
        const { store } = await newStore();
        const paths: string[] = [];
        for (let index = 1; index <= 64; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- Sequential uploads fill the quota in order.
            paths.push(await uploadTiny(store, idOf(index)));
        }
        await expect(uploadTiny(store, idOf(65))).rejects.toMatchObject({ code: 'CAPACITY' });
        const allIds = Array.from({ length: 64 }, (_, index) => idOf(index + 1));
        store.paths('device:1', 'session-one', allIds);
        // Every sent file left the quota, so the next upload fits; the cited files stay readable meanwhile.
        const fresh = await uploadTiny(store, idOf(65));
        expect(store.paths('device:1', 'session-one', [idOf(65)])).toEqual([fresh]);
        expect(() => store.paths('device:1', 'session-one', [idOf(1)])).toThrow();
        expect(store.paths('device:1', 'session-one', [idOf(2)])).toEqual([paths[1]]);
    });
});
