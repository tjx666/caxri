import type { FSWatcher } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertBuildOutputsFresh, createBuildFreshnessGuard } from '../build-freshness';

const temporaryDirectories: string[] = [];
const watchedExtensions = new Set(['.ts', '.ttf']);
const staleMessage = 'stale build';

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'caxri-build-freshness-'));
    temporaryDirectories.push(root);
    const source = join(root, 'src');
    const output = join(root, 'out.js');
    const config = join(root, 'build.config.ts');
    await mkdir(source);
    await writeFile(output, 'output');
    await writeFile(config, 'config');
    return { config, output, root, source };
}

async function setMtime(path: string, seconds: number): Promise<void> {
    const timestamp = new Date(seconds * 1_000);
    await utimes(path, timestamp, timestamp);
}

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe('assertBuildOutputsFresh', () => {
    it('treats explicit build configuration as an input', async () => {
        const paths = await fixture();
        await setMtime(paths.output, 10);
        await setMtime(paths.config, 20);

        await expect(
            assertBuildOutputsFresh({
                inputPaths: [paths.source, paths.config],
                outputPaths: [paths.output],
                watchedDirectoryExtensions: watchedExtensions,
                staleMessage,
            }),
        ).rejects.toThrow(staleMessage);
    });

    it('detects bundled font assets inside source directories', async () => {
        const paths = await fixture();
        const font = join(paths.source, 'terminal.ttf');
        await writeFile(font, 'font');
        await setMtime(paths.output, 10);
        await setMtime(paths.config, 5);
        await setMtime(font, 20);

        await expect(
            assertBuildOutputsFresh({
                inputPaths: [paths.source, paths.config],
                outputPaths: [paths.output],
                watchedDirectoryExtensions: watchedExtensions,
                staleMessage,
            }),
        ).rejects.toThrow(staleMessage);
    });
});

describe('createBuildFreshnessGuard', () => {
    async function freshFixture() {
        const paths = await fixture();
        await setMtime(paths.output, 20);
        await setMtime(paths.config, 10);
        return paths;
    }

    function guardFor(paths: Awaited<ReturnType<typeof fixture>>) {
        return createBuildFreshnessGuard({
            inputPaths: [paths.source, paths.config],
            outputPaths: [paths.output],
            watchedDirectoryExtensions: watchedExtensions,
            staleMessage,
        });
    }

    it('reuses a successful recursive scan while watched inputs stay unchanged', async () => {
        const guard = guardFor(await freshFixture());
        await guard.assertFresh();
        await guard.assertFresh();

        expect(guard.fullScanCount).toBe(1);
        guard.dispose();
    });

    it('rescans and rejects after a watched input changes', async () => {
        const paths = await freshFixture();
        let invalidateSource: (() => void) | undefined;
        const guard = createBuildFreshnessGuard(
            {
                inputPaths: [paths.source, paths.config],
                outputPaths: [paths.output],
                watchedDirectoryExtensions: watchedExtensions,
                staleMessage,
            },
            {
                watch: (path, _options, listener) => {
                    if (path === paths.source) invalidateSource = listener;
                    const watcher = {
                        close() {},
                        on() {
                            return watcher;
                        },
                    };
                    return watcher as unknown as FSWatcher;
                },
            },
        );
        await guard.assertFresh();
        expect(invalidateSource).toBeTypeOf('function');
        const sourceFile = join(paths.source, 'entry.ts');
        await writeFile(sourceFile, 'export {};');
        await setMtime(sourceFile, 30);
        invalidateSource!();

        await expect(guard.assertFresh()).rejects.toThrow(staleMessage);
        expect(guard.fullScanCount).toBe(2);
        guard.dispose();
    });

    it('rejects a deleted output without waiting for a watcher event', async () => {
        const paths = await freshFixture();
        const guard = guardFor(paths);
        await guard.assertFresh();
        await rm(paths.output);

        await expect(guard.assertFresh()).rejects.toThrow(staleMessage);
        expect(guard.fullScanCount).toBe(1);
        guard.dispose();
    });

    it('fails closed when an explicit build input disappears', async () => {
        const paths = await freshFixture();
        const guard = guardFor(paths);
        await rm(paths.config);

        await expect(guard.assertFresh()).rejects.toThrow(staleMessage);
        guard.dispose();
    });

    it('rescans when a required output is replaced before watcher delivery', async () => {
        const paths = await freshFixture();
        const guard = guardFor(paths);
        await guard.assertFresh();
        await writeFile(paths.output, 'replaced output');
        await setMtime(paths.output, 5);

        await expect(guard.assertFresh()).rejects.toThrow(staleMessage);
        expect(guard.fullScanCount).toBe(2);
        guard.dispose();
    });

    it('falls back to a full scan when watcher setup cannot observe an input', async () => {
        const paths = await freshFixture();
        const guard = createBuildFreshnessGuard(
            {
                inputPaths: [paths.source, paths.config],
                outputPaths: [paths.output],
                watchedDirectoryExtensions: watchedExtensions,
                staleMessage,
            },
            {
                watch: () => {
                    throw new Error('watch unavailable');
                },
            },
        );

        await guard.assertFresh();
        await guard.assertFresh();

        expect(guard.fullScanCount).toBe(2);
        guard.dispose();
    });

    it('invalidates the cache after a watcher runtime error', async () => {
        const paths = await freshFixture();
        let sourceWatcherError: (() => void) | undefined;
        const guard = createBuildFreshnessGuard(
            {
                inputPaths: [paths.source, paths.config],
                outputPaths: [paths.output],
                watchedDirectoryExtensions: watchedExtensions,
                staleMessage,
            },
            {
                watch: (path) => {
                    const watcher = {
                        close() {},
                        on(event: string, listener: () => void) {
                            if (event === 'error' && path === paths.source) {
                                sourceWatcherError = listener;
                            }
                            return watcher;
                        },
                    };
                    return watcher as unknown as FSWatcher;
                },
            },
        );
        await guard.assertFresh();
        expect(sourceWatcherError).toBeTypeOf('function');
        sourceWatcherError!();
        await guard.assertFresh();

        expect(guard.fullScanCount).toBe(2);
        guard.dispose();
    });
});
