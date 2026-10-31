import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';

import type { StructuredLogger } from '@caxri/system';
import { execFileAsync, logEventCatalog } from '@caxri/system';

/**
 * The poster's longest edge in pixels, as Desktop's media scheme draws it: sharp on the phone's card at 3x.
 */
const POSTER_SIZE = 480;
/**
 * QuickLook waits indefinitely on some files (one still being written), so a draw that takes longer is abandoned.
 */
const POSTER_TIMEOUT_MS = 15_000;
const POSTER_CACHE_LIMIT = 32;
const POSTER_JPEG_QUALITY = '70';

export interface MobileVideoPoster {
    mediaType: 'image/jpeg' | 'image/png';
    /**
     * The whole image as base64.
     */
    data: string;
}

type PosterOutcome = 'drawn' | 'failed' | 'timeout' | 'unsupported';

export type RunCommand = (
    file: string,
    arguments_: readonly string[],
    options: { timeout: number },
) => Promise<unknown>;

const runCommand: RunCommand = (file, arguments_, options) =>
    execFileAsync(file, [...arguments_], { ...options, killSignal: 'SIGKILL' });

const isTimeout = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && 'killed' in error && error.killed === true;

/**
 * Draws poster frames for the videos a phone shows as cards. Server Core has no Electron `nativeImage`, which Desktop's
 * media scheme draws with, so this asks the same QuickLook through its command line (`qlmanage -t`) and shrinks the PNG
 * to a JPEG with `sips`, a fraction of the size, so a poster costs fewer frames over the Relay. Both ship with macOS;
 * elsewhere there is no poster and the card shows its placeholder. Posters are cached by resolved path and modification
 * time, and concurrent asks for one file share a single draw.
 */
export function createMobileVideoPosterReader(options: {
    logger?: Pick<StructuredLogger, 'write'>;
    now?: () => number;
    platform?: NodeJS.Platform;
    run?: RunCommand;
}) {
    const now = options.now ?? Date.now;
    const platform = options.platform ?? process.platform;
    const run = options.run ?? runCommand;
    const cache = new Map<string, MobileVideoPoster | null>();
    const drawing = new Map<string, Promise<MobileVideoPoster | null>>();

    const record = (outcome: PosterOutcome, startedAt: number): void => {
        options.logger?.write(
            outcome === 'drawn' ? 'info' : 'warn',
            logEventCatalog.mobileGateway.videoPoster,
            { fields: { durationMs: now() - startedAt, outcome } },
        );
    };

    const draw = async (path: string): Promise<MobileVideoPoster | null> => {
        const startedAt = now();
        if (platform !== 'darwin') {
            record('unsupported', startedAt);
            return null;
        }
        const directory = await mkdtemp(join(tmpdir(), 'caxri-video-poster-'));
        try {
            await run('qlmanage', ['-t', '-s', String(POSTER_SIZE), '-o', directory, path], {
                timeout: POSTER_TIMEOUT_MS,
            });
            const png = join(directory, `${basename(path)}.png`);
            const jpeg = join(directory, 'poster.jpg');
            let poster: MobileVideoPoster;
            try {
                await run(
                    'sips',
                    [
                        '-s',
                        'format',
                        'jpeg',
                        '-s',
                        'formatOptions',
                        POSTER_JPEG_QUALITY,
                        png,
                        '--out',
                        jpeg,
                    ],
                    { timeout: POSTER_TIMEOUT_MS },
                );
                poster = {
                    mediaType: 'image/jpeg',
                    data: (await readFile(jpeg)).toString('base64'),
                };
            } catch {
                // QuickLook drew nothing (an unsupported codec) when its PNG is missing too; that read fails below.
                poster = { mediaType: 'image/png', data: (await readFile(png)).toString('base64') };
            }
            record('drawn', startedAt);
            return poster;
        } catch (error) {
            record(isTimeout(error) ? 'timeout' : 'failed', startedAt);
            return null;
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    };

    return async (file: {
        modifiedAt: number;
        path: string;
    }): Promise<MobileVideoPoster | null> => {
        const key = `${file.path}\0${file.modifiedAt}`;
        if (cache.has(key)) return cache.get(key) ?? null;
        const pending = drawing.get(key) ?? draw(file.path);
        drawing.set(key, pending);
        try {
            const poster = await pending;
            cache.set(key, poster);
            while (cache.size > POSTER_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
            return poster;
        } finally {
            drawing.delete(key);
        }
    };
}
