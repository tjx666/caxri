import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createRendererStackSampler,
    formatRendererStack,
    MAX_STACK_FRAMES,
} from '../renderer-hang-stack';

const FRAMES = [
    {
        functionName: 'measureSidebarRows',
        url: 'index-abc.js',
        location: { lineNumber: 0, columnNumber: 9 },
    },
    {
        functionName: 'selectSession',
        url: 'index-abc.js',
        location: { lineNumber: 0, columnNumber: 99 },
    },
];

/**
 * A fake `webContents.debugger` that records commands and lets a test deliver `Debugger.paused` whenever it likes, the
 * way a Renderer stuck in native work delivers it only after the thread yields.
 */
function fakeWebContents(options: { attachedElsewhere?: boolean } = {}) {
    let onMessage: ((event: unknown, method: string, parameters: unknown) => void) | undefined;
    const commands: string[] = [];
    const inspector = {
        isAttached: () => options.attachedElsewhere ?? false,
        attach: vi.fn(),
        on: (
            event: string,
            listener: (event: unknown, method: string, parameters: unknown) => void,
        ) => {
            if (event === 'message') onMessage = listener;
            return inspector;
        },
        sendCommand: vi.fn((method: string) => {
            commands.push(method);
            return Promise.resolve({});
        }),
    };
    const webContents = {
        debugger: inspector,
        isDestroyed: () => false,
        on: () => webContents,
    } as unknown as WebContents;
    return {
        commands,
        inspector,
        pause: (reason = 'other') =>
            onMessage?.({}, 'Debugger.paused', { reason, callFrames: FRAMES }),
        webContents,
    };
}

describe('createRendererStackSampler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('enables the debugger up front, then pauses once, names the stack, and resumes', async () => {
        const fake = fakeWebContents();
        const sampler = createRendererStackSampler(fake.webContents);
        expect(fake.inspector.attach).toHaveBeenCalledOnce();
        expect(fake.commands).toEqual(['Debugger.enable']);

        const capture = sampler.capture();
        fake.pause();

        await expect(capture).resolves.toEqual({
            outcome: 'captured',
            stack: 'measureSidebarRows@index-abc.js:1:10;selectSession@index-abc.js:1:100',
        });
        expect(fake.commands).toEqual(['Debugger.enable', 'Debugger.pause', 'Debugger.resume']);
    });

    /**
     * The regression this guards would leave the user's window stopped in the debugger after a capture timed out.
     */
    it('still resumes a requested pause that lands after the capture timed out', async () => {
        const fake = fakeWebContents();
        const sampler = createRendererStackSampler(fake.webContents);

        const capture = sampler.capture();
        await vi.advanceTimersByTimeAsync(3_000);
        await expect(capture).resolves.toEqual({ outcome: 'timeout' });

        fake.pause();

        expect(fake.commands.at(-1)).toBe('Debugger.resume');
    });

    it('leaves a pause it did not request to its owner', () => {
        const fake = fakeWebContents();
        createRendererStackSampler(fake.webContents);

        fake.pause('breakpoint');

        expect(fake.commands).not.toContain('Debugger.resume');
    });

    it('reports a debugger another client owns', async () => {
        const fake = fakeWebContents({ attachedElsewhere: true });
        const sampler = createRendererStackSampler(fake.webContents);

        await expect(sampler.capture()).resolves.toEqual({ outcome: 'debugger-busy' });
        expect(fake.inspector.attach).not.toHaveBeenCalled();
    });
});

describe('formatRendererStack', () => {
    it('keeps only file names, one-based positions, and a name for anonymous frames', () => {
        const stack = formatRendererStack([
            {
                functionName: 'measureRows',
                url: 'file:///Applications/Caxri.app/Contents/Resources/app.asar/out/renderer/assets/index-abc.js',
                location: { lineNumber: 0, columnNumber: 41 },
            },
            {
                functionName: '',
                url: 'http://localhost:5173/src/features/sidebar/session-row.tsx?t=1730000000',
                location: { lineNumber: 9 },
            },
            { functionName: 'native', url: '', location: { lineNumber: 0 } },
        ]);

        expect(stack).toBe(
            'measureRows@index-abc.js:1:42;(anonymous)@session-row.tsx:10:1;native@-:1:1',
        );
    });

    it('bounds the stack to the innermost frames', () => {
        const frames = Array.from({ length: MAX_STACK_FRAMES + 5 }, (_, index) => ({
            functionName: `f${index}`,
            url: 'index.js',
            location: { lineNumber: 0 },
        }));

        expect(formatRendererStack(frames).split(';')).toHaveLength(MAX_STACK_FRAMES);
        expect(formatRendererStack(frames).startsWith('f0@')).toBe(true);
    });
});
