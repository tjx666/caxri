// oxlint-disable typescript/require-await -- Async command fakes preserve the production Promise boundary.
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createMobileVideoPosterReader } from '../poster';

const FILE = { modifiedAt: 1, path: '/Users/me/Desktop/demo.mp4' };

const drawingRun = (sips: 'fails' | 'works' = 'works') =>
    vi.fn(async (file: string, arguments_: readonly string[]) => {
        if (file === 'qlmanage') {
            const directory = arguments_[arguments_.indexOf('-o') + 1];
            await writeFile(path.join(directory, 'demo.mp4.png'), 'PNG');
            return;
        }
        if (sips === 'fails') throw new Error('sips failed');
        await writeFile(arguments_.at(-1)!, 'JPEG');
    });

describe('createMobileVideoPosterReader', () => {
    it('draws a JPEG once per file version and shares concurrent draws', async () => {
        const run = drawingRun();
        const logger = { write: vi.fn() };
        const read = createMobileVideoPosterReader({ logger, platform: 'darwin', run });
        const [first, second] = await Promise.all([read(FILE), read(FILE)]);
        expect(first).toEqual({
            mediaType: 'image/jpeg',
            data: Buffer.from('JPEG').toString('base64'),
        });
        expect(second).toEqual(first);
        await read(FILE);
        expect(run.mock.calls.filter(([file]) => file === 'qlmanage')).toHaveLength(1);
        await read({ ...FILE, modifiedAt: 2 });
        expect(run.mock.calls.filter(([file]) => file === 'qlmanage')).toHaveLength(2);
        expect(logger.write).toHaveBeenCalledWith('info', 'mobile_gateway.video_poster', {
            fields: { durationMs: expect.any(Number) as number, outcome: 'drawn' },
        });
    });

    it('keeps the PNG when it cannot be shrunk', async () => {
        const read = createMobileVideoPosterReader({
            platform: 'darwin',
            run: drawingRun('fails'),
        });
        await expect(read(FILE)).resolves.toEqual({
            mediaType: 'image/png',
            data: Buffer.from('PNG').toString('base64'),
        });
    });

    it('has no poster without QuickLook, when it draws nothing, or when it times out', async () => {
        const logger = { write: vi.fn() };
        const run = vi.fn();
        await expect(
            createMobileVideoPosterReader({ logger, platform: 'linux', run })(FILE),
        ).resolves.toBeNull();
        expect(run).not.toHaveBeenCalled();
        await expect(
            createMobileVideoPosterReader({
                logger,
                platform: 'darwin',
                run: vi.fn(async () => {}),
            })(FILE),
        ).resolves.toBeNull();
        const timeout = Object.assign(new Error('timed out'), { killed: true });
        await expect(
            createMobileVideoPosterReader({
                logger,
                platform: 'darwin',
                run: vi.fn(async () => {
                    throw timeout;
                }),
            })(FILE),
        ).resolves.toBeNull();
        expect(
            logger.write.mock.calls.map(
                (call) =>
                    (call as unknown as [string, string, { fields: { outcome: string } }])[2].fields
                        .outcome,
            ),
        ).toEqual(['unsupported', 'failed', 'timeout']);
    });
});
