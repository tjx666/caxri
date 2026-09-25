import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import {
    captureFrames,
    captureScreenshot,
    parseCaptureOptions,
    requireCapturePreflight,
    requiresRuntimeTerminalFixturePreflight,
    resolveOwnedCapturePort,
} from './capture-renderer';
import { createTerminalFixturePreflightReceipt } from './fixture-preflight';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true })));
});

describe('Acceptance Renderer capture', () => {
    it('parses a single screenshot capture', () => {
        expect(
            parseCaptureOptions(['screenshot', '--port', '9222', '--output', './screenshot.png']),
        ).toMatchObject({
            command: 'screenshot',
            output: join(process.cwd(), 'screenshot.png'),
            port: 9222,
        });
        expect(() => parseCaptureOptions(['screenshot'])).toThrow('--output is required');
        expect(() => parseCaptureOptions(['screenshot', './screenshot.png'])).toThrow(
            'pass the screenshot path with --output <file>',
        );
        expect(() => parseCaptureOptions(['screenshot', '--output', './screenshot.jpg'])).toThrow(
            '--output must use a .png extension',
        );
        expect(() =>
            parseCaptureOptions([
                'screenshot',
                '--output',
                './screenshot.png',
                '--selector',
                'main',
            ]),
        ).toThrow('Unknown option: --selector');
    });

    it('captures a screenshot without changing Renderer focus', async () => {
        const options = parseCaptureOptions(['screenshot', '--output', './settled.png']);
        if (options === 'help' || options.command !== 'screenshot') {
            throw new Error('Expected screenshot options');
        }
        const directory = await mkdtemp(join(tmpdir(), 'caxri-screenshot-'));
        temporaryDirectories.push(directory);
        const output = join(directory, 'settled.png');
        const methods: string[] = [];
        let isClosed = false;

        await captureScreenshot({ ...options, output }, 9222, () =>
            Promise.resolve({
                close: () => {
                    isClosed = true;
                },
                request: <T>(method: string): Promise<T> => {
                    methods.push(method);
                    return Promise.resolve(
                        (method === 'Page.captureScreenshot'
                            ? { data: Buffer.from('png-data').toString('base64') }
                            : {}) as T,
                    );
                },
            }),
        );

        expect(methods).toEqual(['Page.enable', 'Page.captureScreenshot']);
        expect(await readFile(output, 'utf8')).toBe('png-data');
        expect(isClosed).toBe(true);
    });

    it('captures frame evidence without changing Renderer focus', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-frame-capture-'));
        temporaryDirectories.push(directory);
        const fixturePreflight = join(directory, 'fixture.json');
        const outDirectory = join(directory, 'frames');
        await writeFile(
            fixturePreflight,
            JSON.stringify(
                createTerminalFixturePreflightReceipt(
                    {
                        columns: 8,
                        domRowCount: 3,
                        firstGridMarker: { columns: 8, generation: 'fixture-1', rows: 3 },
                        generation: 'fixture-1',
                        lines: ['│12345 │', '│A中🙂 │', '│e\u{301}     │'],
                        rows: 3,
                    },
                    'terminal-layout',
                ),
            ),
        );
        const options = parseCaptureOptions([
            'frames',
            '--out-dir',
            outDirectory,
            '--fixture-preflight',
            fixturePreflight,
            '--count',
            '1',
        ]);
        if (options === 'help' || options.command !== 'frames') {
            throw new Error('Expected frame options');
        }
        const methods: string[] = [];

        await captureFrames(options, 9222, () =>
            Promise.resolve({
                close: () => {},
                request: <T>(method: string): Promise<T> => {
                    methods.push(method);
                    return Promise.resolve(
                        (method === 'Page.captureScreenshot'
                            ? { data: Buffer.from('frame-data').toString('base64') }
                            : {}) as T,
                    );
                },
            }),
        );

        expect(methods).toEqual(['Page.enable', 'Page.captureScreenshot']);
        expect(await readFile(join(outDirectory, 'frame_000000.png'), 'utf8')).toBe('frame-data');
    });

    it('parses bounded frame capture options', () => {
        expect(
            parseCaptureOptions([
                'frames',
                '--port',
                '9222',
                '--out-dir',
                './frames',
                '--fixture-preflight',
                './fixture.json',
                '--count',
                '8',
                '--interval-ms',
                '100',
            ]),
        ).toMatchObject({ command: 'frames', count: 8, intervalMs: 100, port: 9222 });
    });

    it('requires and enforces fixture preflight for Terminal fixture frame capture', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-capture-preflight-'));
        temporaryDirectories.push(directory);
        const optionsWithoutPreflight = parseCaptureOptions([
            'frames',
            '--out-dir',
            join(directory, 'missing-preflight-frames'),
            '--count',
            '1',
        ]);
        if (optionsWithoutPreflight === 'help' || optionsWithoutPreflight.command !== 'frames') {
            throw new Error('Expected frame options');
        }
        await expect(captureFrames(optionsWithoutPreflight, 9222)).rejects.toThrow(
            '--fixture-preflight is required for a terminal fixture frame capture',
        );
        const path = join(directory, 'fixture.json');
        await writeFile(
            path,
            JSON.stringify(
                createTerminalFixturePreflightReceipt(
                    {
                        columns: 8,
                        domRowCount: 1,
                        firstGridMarker: { columns: 8, generation: 'fixture-1', rows: 1 },
                        generation: 'fixture-1',
                        lines: ['│中🙂   │'],
                        rows: 1,
                    },
                    'terminal-layout',
                ),
            ),
        );

        await expect(requireCapturePreflight(path)).rejects.toThrow(
            'Frame capture blocked by fixture preflight',
        );

        const forged = createTerminalFixturePreflightReceipt(
            {
                columns: 8,
                domRowCount: 1,
                firstGridMarker: { columns: 8, generation: 'fixture-2', rows: 1 },
                generation: 'fixture-2',
                lines: ['│12345 │'],
                rows: 1,
            },
            'terminal-layout',
        );
        forged.result.lines[0].width = 7;
        await writeFile(path, JSON.stringify(forged));
        await expect(requireCapturePreflight(path)).rejects.toThrow();

        const ready = createTerminalFixturePreflightReceipt(
            {
                columns: 8,
                domRowCount: 1,
                firstGridMarker: { columns: 8, generation: 'fixture-3', rows: 1 },
                generation: 'fixture-3',
                lines: ['│12345 │'],
                rows: 1,
            },
            'terminal-layout',
        );
        await writeFile(
            path,
            JSON.stringify({ ...ready, fixture: { ...ready.fixture, lines: ['│12345 │'] } }),
        );
        await expect(requireCapturePreflight(path)).rejects.toThrow();

        await writeFile(
            path,
            JSON.stringify({ ...ready, result: { ...ready.result, status: 'fixture_blocked' } }),
        );
        await expect(requireCapturePreflight(path)).rejects.toThrow();
    });

    it('captures non-Terminal temporal evidence when the frozen launch plan opts out', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-non-terminal-frame-capture-'));
        temporaryDirectories.push(directory);
        const outDirectory = join(directory, 'frames');
        const options = parseCaptureOptions(['frames', '--out-dir', outDirectory, '--count', '1']);
        if (options === 'help' || options.command !== 'frames') {
            throw new Error('Expected frame options');
        }

        await captureFrames(
            options,
            9222,
            () =>
                Promise.resolve({
                    close: () => {},
                    request: <T>(method: string): Promise<T> =>
                        Promise.resolve(
                            (method === 'Page.captureScreenshot'
                                ? { data: Buffer.from('frame-data').toString('base64') }
                                : {}) as T,
                        ),
                }),
            false,
        );

        expect(await readFile(join(outDirectory, 'frame_000000.png'), 'utf8')).toBe('frame-data');
    });

    it('requires capture to use the owned Acceptance CDP port', () => {
        expect(resolveOwnedCapturePort(9222)).toBe(9222);
        expect(() => resolveOwnedCapturePort(9222, 9333)).toThrow(
            'does not match owned Acceptance port',
        );
    });

    it('fails closed for old runtime receipts and only skips preflight after an explicit opt-out', () => {
        expect(requiresRuntimeTerminalFixturePreflight(undefined)).toBe(true);
        expect(
            requiresRuntimeTerminalFixturePreflight({
                id: 'old-runtime',
                mode: 'isolated',
            }),
        ).toBe(true);
        expect(
            requiresRuntimeTerminalFixturePreflight({
                id: 'non-terminal-recording',
                mode: 'isolated',
                requiresTerminalFixturePreflight: false,
            }),
        ).toBe(false);
    });

    it('bounds frame count before capture starts', () => {
        expect(() =>
            parseCaptureOptions([
                'frames',
                '--out-dir',
                './frames',
                '--fixture-preflight',
                './fixture.json',
                '--count',
                '601',
            ]),
        ).toThrow('--count must be an integer between 1 and 600');
    });
});
