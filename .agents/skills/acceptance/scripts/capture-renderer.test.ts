import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    parseCaptureOptions,
    requireCapturePreflight,
    resolveOwnedCapturePort,
    selectRendererTarget,
} from './capture-renderer';
import { createTerminalFixturePreflightReceipt } from './fixture-preflight';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('Acceptance Renderer capture', () => {
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

    it('requires and enforces fixture preflight before frame capture', async () => {
        expect(() => parseCaptureOptions(['frames', '--out-dir', './frames'])).toThrow(
            '--fixture-preflight is required',
        );
        const directory = await mkdtemp(join(tmpdir(), 'caxri-capture-preflight-'));
        temporaryDirectories.push(directory);
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
        await expect(requireCapturePreflight(path)).rejects.toThrow(
            'does not match its observed fixture',
        );
    });

    it('selects the Caxri Renderer instead of DevTools', () => {
        expect(
            selectRendererTarget([
                {
                    type: 'page',
                    url: 'devtools://devtools/bundled/inspector.html',
                    webSocketDebuggerUrl: 'ws://devtools',
                },
                {
                    type: 'page',
                    url: 'file:///tmp/caxri/out/renderer/index.html',
                    webSocketDebuggerUrl: 'ws://renderer',
                },
            ]).webSocketDebuggerUrl,
        ).toBe('ws://renderer');
    });

    it('selects the main Renderer by default and allows an explicit secondary target', () => {
        const targets = [
            {
                type: 'page',
                url: 'file:///tmp/caxri/out/renderer/index.html',
                webSocketDebuggerUrl: 'ws://main',
            },
            {
                type: 'page',
                url: 'file:///tmp/caxri/out/renderer/process-explorer.html',
                webSocketDebuggerUrl: 'ws://process-explorer',
            },
        ];

        expect(selectRendererTarget(targets).webSocketDebuggerUrl).toBe('ws://main');
        expect(selectRendererTarget(targets, 'process-explorer.html').webSocketDebuggerUrl).toBe(
            'ws://process-explorer',
        );
    });

    it('requires capture to use the owned Acceptance CDP port', () => {
        expect(resolveOwnedCapturePort(9222)).toBe(9222);
        expect(() => resolveOwnedCapturePort(9222, 9333)).toThrow(
            'does not match owned Acceptance port',
        );
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

    it('fails closed when Renderer target selection is ambiguous', () => {
        expect(() =>
            selectRendererTarget([
                {
                    type: 'page',
                    url: 'file:///one/out/renderer/index.html',
                    webSocketDebuggerUrl: 'ws://one',
                },
                {
                    type: 'page',
                    url: 'file:///two/out/renderer/index.html',
                    webSocketDebuggerUrl: 'ws://two',
                },
            ]),
        ).toThrow('Expected exactly one Caxri Renderer CDP target');
    });
});
