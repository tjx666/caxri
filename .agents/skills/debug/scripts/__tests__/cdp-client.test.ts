import { describe, expect, it } from 'vitest';

import { selectRendererTarget } from '../cdp-client';

describe('Renderer CDP target selection', () => {
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

    it('selects the dev server page of an unpackaged launch', () => {
        expect(
            selectRendererTarget([
                { type: 'worker', url: '', webSocketDebuggerUrl: 'ws://worker' },
                { type: 'page', url: 'http://localhost:5173/', webSocketDebuggerUrl: 'ws://dev' },
            ]).webSocketDebuggerUrl,
        ).toBe('ws://dev');
    });

    it('selects the dev main window while a Caxri Bot or Process Explorer window is open', () => {
        const targets = [
            {
                type: 'page',
                url: 'http://localhost:5173/caxri-bot.html',
                webSocketDebuggerUrl: 'ws://bot',
            },
            { type: 'page', url: 'http://localhost:5173/', webSocketDebuggerUrl: 'ws://main' },
            {
                type: 'page',
                url: 'http://localhost:5173/process-explorer.html',
                webSocketDebuggerUrl: 'ws://process-explorer',
            },
        ];

        expect(selectRendererTarget(targets).webSocketDebuggerUrl).toBe('ws://main');
        expect(selectRendererTarget(targets, 'caxri-bot').webSocketDebuggerUrl).toBe('ws://bot');
    });

    it('treats a dev index.html page as the main window', () => {
        expect(
            selectRendererTarget([
                {
                    type: 'page',
                    url: 'http://localhost:5173/index.html#/',
                    webSocketDebuggerUrl: 'ws://main',
                },
                {
                    type: 'page',
                    url: 'http://localhost:5173/caxri-bot.html',
                    webSocketDebuggerUrl: 'ws://bot',
                },
            ]).webSocketDebuggerUrl,
        ).toBe('ws://main');
    });

    it('refuses an ambiguous target list instead of guessing', () => {
        expect(() =>
            selectRendererTarget([
                { type: 'page', url: 'http://localhost:5173/', webSocketDebuggerUrl: 'ws://one' },
                { type: 'page', url: 'http://localhost:5174/', webSocketDebuggerUrl: 'ws://two' },
            ]),
        ).toThrow('Expected exactly one Caxri Renderer CDP target');
    });

    it('fails closed when two built launches expose the same Renderer entry', () => {
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
