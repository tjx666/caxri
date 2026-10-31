import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MobileVideoServer } from '../server';

const GRANT = { deviceId: 'device-1', generation: 1 };
const fixture = { directory: '', video: '' };
const state = { authorized: true, server: undefined as unknown as MobileVideoServer };

beforeEach(async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'caxri-video-server-'));
    fixture.directory = await realpath(directory);
    fixture.video = path.join(fixture.directory, 'Recording 13.37.mov');
    await writeFile(fixture.video, '0123456789');
    state.authorized = true;
    let seed = 0;
    state.server = new MobileVideoServer({
        authorize: () => state.authorized,
        random: (bytes) => new Uint8Array(bytes).fill((seed += 1)),
    });
});

afterEach(async () => {
    await state.server.clear();
    await rm(fixture.directory, { recursive: true, force: true });
});

const open = () =>
    state.server.open(GRANT, '127.0.0.1', { path: fixture.video, resolvedPath: fixture.video });

describe('MobileVideoServer', () => {
    it('streams the whole video and answers the first, a middle, and an out-of-range part', async () => {
        const url = await open();
        const whole = await fetch(url);
        expect(whole.status).toBe(200);
        expect(whole.headers.get('accept-ranges')).toBe('bytes');
        expect(whole.headers.get('content-type')).toBe('video/quicktime');
        expect(await whole.text()).toBe('0123456789');

        const first = await fetch(url, { headers: { range: 'bytes=0-1' } });
        expect(first.status).toBe(206);
        expect(first.headers.get('content-range')).toBe('bytes 0-1/10');
        expect(await first.text()).toBe('01');

        const middle = await fetch(url, { headers: { range: 'bytes=4-6' } });
        expect(middle.status).toBe(206);
        expect(middle.headers.get('content-range')).toBe('bytes 4-6/10');
        expect(await middle.text()).toBe('456');

        const past = await fetch(url, { headers: { range: 'bytes=10-' } });
        expect(past.status).toBe(416);
        expect(past.headers.get('content-range')).toBe('bytes */10');
    });

    it('refuses an unknown token, a revoked device, and a cleared server', async () => {
        const url = await open();
        expect((await fetch(`${url.slice(0, -64)}${'f'.repeat(64)}`)).status).toBe(404);
        state.authorized = false;
        expect((await fetch(url)).status).toBe(403);
        state.authorized = true;
        await state.server.clear();
        await expect(fetch(url)).rejects.toThrow();
    });

    it('stops serving a video that was deleted or replaced by a link to another file', async () => {
        const url = await open();
        await rm(fixture.video);
        expect((await fetch(url)).status).toBe(404);
        const other = path.join(fixture.directory, 'other.mov');
        await writeFile(other, 'other');
        await symlink(other, fixture.video);
        expect((await fetch(url)).status).toBe(404);
    });

    it('shares one listener between URLs on the same address', async () => {
        const first = new URL(await open());
        const second = new URL(await open());
        expect(second.port).toBe(first.port);
        expect(second.pathname).not.toBe(first.pathname);
    });
});
