import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agentChatMediaUrl } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
    app: { whenReady: vi.fn() },
    nativeImage: { createThumbnailFromPath: vi.fn() },
    protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));
vi.mock('electron', () => electronMock);

import { agentChatByteRange, agentChatMediaResponse } from '../media-protocol';

const fixture = { directory: '' };

beforeEach(async () => {
    electronMock.nativeImage.createThumbnailFromPath.mockReset();
    const directory = await mkdtemp(join(tmpdir(), 'caxri-chat-media-'));
    fixture.directory = await realpath(directory);
});

afterEach(async () => {
    await rm(fixture.directory, { recursive: true, force: true });
});

function request(kind: 'poster' | 'video', path: string, headers?: HeadersInit): Request {
    // `Request` refuses a scheme it does not know, so the URL rides on a stand-in and the handler reads `url`.
    return { url: agentChatMediaUrl(kind, path), headers: new Headers(headers) } as Request;
}

describe('agentChatMediaResponse', () => {
    it('streams a video, answering a range request with the bytes it asks for', async () => {
        const video = join(fixture.directory, 'Recording 13.37.mov');
        await writeFile(video, '0123456789');
        const whole = await agentChatMediaResponse(request('video', video));
        expect(whole.status).toBe(200);
        expect(whole.headers.get('accept-ranges')).toBe('bytes');
        expect(whole.headers.get('content-type')).toBe('video/quicktime');
        expect(await whole.text()).toBe('0123456789');

        const part = await agentChatMediaResponse(request('video', video, { range: 'bytes=4-6' }));
        expect(part.status).toBe(206);
        expect(part.headers.get('content-range')).toBe('bytes 4-6/10');
        expect(await part.text()).toBe('456');

        const past = await agentChatMediaResponse(request('video', video, { range: 'bytes=20-' }));
        expect(past.status).toBe(416);
    });

    it('answers a poster with the PNG QuickLook draws, and 404 when it has none', async () => {
        const video = join(fixture.directory, 'clip.mp4');
        await writeFile(video, 'video');
        electronMock.nativeImage.createThumbnailFromPath.mockResolvedValueOnce({
            isEmpty: () => false,
            toPNG: () => Buffer.from([1, 2, 3]),
        });
        const response = await agentChatMediaResponse(request('poster', video));
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

        const other = join(fixture.directory, 'broken.webm');
        await writeFile(other, 'video');
        electronMock.nativeImage.createThumbnailFromPath.mockRejectedValueOnce(new Error('none'));
        expect((await agentChatMediaResponse(request('poster', other))).status).toBe(404);
    });

    it('serves no file that is not a video, even through a symlink named like one', async () => {
        const secret = join(fixture.directory, 'secret.txt');
        await writeFile(secret, 'secret');
        const disguised = join(fixture.directory, 'disguised.mov');
        await symlink(secret, disguised);
        const folder = join(fixture.directory, 'folder.mov');
        await mkdir(folder);

        expect((await agentChatMediaResponse(request('video', secret))).status).toBe(400);
        expect((await agentChatMediaResponse(request('video', disguised))).status).toBe(404);
        expect((await agentChatMediaResponse(request('video', folder))).status).toBe(404);
        const gone = request('video', join(fixture.directory, 'gone.mov'));
        expect((await agentChatMediaResponse(gone)).status).toBe(404);
    });
});

describe('agentChatByteRange', () => {
    it('reads open-ended, suffix, and clamped ranges', () => {
        expect(agentChatByteRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
        expect(agentChatByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
        expect(agentChatByteRange('bytes=5-99', 10)).toEqual({ start: 5, end: 9 });
    });

    it('sends the whole file for no or a multi-part range, and refuses one past the end', () => {
        expect(agentChatByteRange(null, 10)).toBeUndefined();
        expect(agentChatByteRange('bytes=0-1,4-5', 10)).toBeUndefined();
        expect(agentChatByteRange('bytes=10-', 10)).toBe('unsatisfiable');
        expect(agentChatByteRange('bytes=6-2', 10)).toBe('unsatisfiable');
    });
});
