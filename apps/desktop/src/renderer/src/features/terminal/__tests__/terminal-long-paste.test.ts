import type { TerminalLongPasteResult } from '@caxri/protocol';
import {
    formatLongPasteReference,
    MAX_LONG_PASTE_BYTES,
    MAX_TERMINAL_INPUT_PAYLOAD_LENGTH,
} from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    longPasteFailureMessage,
    shouldPrepareLongPaste,
    TerminalLongPasteController,
    TerminalLongPasteInputRoute,
} from '../terminal-long-paste';

type SavedLongPaste = Extract<TerminalLongPasteResult, { status: 'saved' }>;

describe('long Terminal paste', () => {
    it.each(['keyboard', 'clipboard'] as const)(
        'rejects oversized UTF-8 content through %s without a request or native paste',
        async (entry) => {
            const content = '界'.repeat(Math.floor(MAX_LONG_PASTE_BYTES / 3) + 1);
            const request = vi.fn();
            const paste = vi.fn();
            const onFailure = vi.fn();
            const controller = new TerminalLongPasteController({
                canAcceptAgentInput: () => true,
                onDropped: vi.fn(),
                onFailure,
                onPendingChange: vi.fn(),
                paste,
                pasteAgentExact: paste,
                request,
                threshold: () => 1_024,
            });
            if (entry === 'keyboard') expect(controller.intercept(content)).toBe(true);
            else await controller.pasteFromClipboard(() => Promise.resolve(content));
            await vi.waitFor(() => expect(controller.isPending()).toBe(false));
            expect(request).not.toHaveBeenCalled();
            expect(paste).not.toHaveBeenCalled();
            expect(onFailure).toHaveBeenCalledExactlyOnceWith('too-large');
            expect(longPasteFailureMessage('too-large')).toContain('16 MiB');
            expect(longPasteFailureMessage('too-large')).toContain('clipboard is unchanged');
        },
    );

    it.each(['keyboard', 'clipboard'] as const)(
        'does not pass an oversized unmanaged Agent paste to xterm through %s',
        async (entry) => {
            const content = 'x'.repeat(MAX_TERMINAL_INPUT_PAYLOAD_LENGTH);
            const paste = vi.fn();
            const onFailure = vi.fn();
            const controller = new TerminalLongPasteController({
                canAcceptAgentInput: () => true,
                onDropped: vi.fn(),
                onFailure,
                onPendingChange: vi.fn(),
                paste,
                pasteAgentExact: paste,
                request: () => Promise.resolve({ status: 'passthrough' }),
                threshold: () => 1_024,
            });
            if (entry === 'keyboard') expect(controller.intercept(content)).toBe(true);
            else await controller.pasteFromClipboard(() => Promise.resolve(content));
            await vi.waitFor(() => expect(controller.isPending()).toBe(false));
            expect(paste).not.toHaveBeenCalled();
            expect(onFailure).toHaveBeenCalledExactlyOnceWith('native-too-large');
            expect(longPasteFailureMessage('native-too-large')).toContain('Save it to a file');
        },
    );

    it.each(['stopped', 'disposed'] as const)(
        'does not deliver a delayed native paste after the Agent is %s',
        async (state) => {
            const response = Promise.withResolvers<{ status: 'passthrough' }>();
            let isRunning = true;
            const paste = vi.fn();
            const controller = new TerminalLongPasteController({
                canAcceptAgentInput: () => isRunning,
                onDropped: vi.fn(),
                onFailure: vi.fn(),
                onPendingChange: vi.fn(),
                paste,
                pasteAgentExact: paste,
                request: () => response.promise,
                threshold: () => 1,
            });
            controller.intercept('pending native text');
            if (state === 'disposed') controller.dispose();
            else isRunning = false;
            response.resolve({ status: 'passthrough' });
            await response.promise;

            expect(controller.isPending()).toBe(false);
            expect(paste).not.toHaveBeenCalled();
        },
    );

    it.each(['keyboard', 'clipboard'] as const)(
        'preserves native paste for an unmanaged Agent through the %s entry point',
        async (entry) => {
            const content = 'native paste\n'.repeat(200);
            const pending: boolean[] = [];
            const paste = vi.fn(() => expect(pending.at(-1)).toBe(false));
            const pasteAgentExact = vi.fn();
            const onFailure = vi.fn();
            const controller = new TerminalLongPasteController({
                canAcceptAgentInput: () => true,
                onDropped: vi.fn(),
                onFailure,
                onPendingChange: (value) => pending.push(value),
                paste,
                pasteAgentExact,
                request: () => Promise.resolve({ status: 'passthrough' }),
                threshold: () => 1_024,
            });

            if (entry === 'keyboard') expect(controller.intercept(content)).toBe(true);
            else await controller.pasteFromClipboard(() => Promise.resolve(content));
            await vi.waitFor(() => expect(controller.isPending()).toBe(false));

            expect(paste).toHaveBeenCalledExactlyOnceWith(content);
            expect(pasteAgentExact).not.toHaveBeenCalled();
            expect(onFailure).not.toHaveBeenCalled();
            expect(pending).toEqual([true, false]);
        },
    );

    it('triggers only above the configurable threshold for a running Agent', () => {
        expect(
            shouldPrepareLongPaste({
                canAcceptAgentInput: true,
                text: 'x'.repeat(1_024),
                threshold: 1_024,
            }),
        ).toBe(false);
        expect(
            shouldPrepareLongPaste({
                canAcceptAgentInput: true,
                text: 'x'.repeat(1_025),
                threshold: 1_024,
            }),
        ).toBe(true);
        expect(
            shouldPrepareLongPaste({
                canAcceptAgentInput: false,
                text: 'x'.repeat(2_000),
                threshold: 1_024,
            }),
        ).toBe(false);
    });

    it('locks input synchronously and pastes only the reference to the saved original', async () => {
        const pending: boolean[] = [];
        const pasted: string[] = [];
        const expectedLaunchIds: string[] = [];
        const request = Promise.withResolvers<SavedLongPaste>();
        const onDropped = vi.fn();
        const controller = new TerminalLongPasteController({
            canAcceptAgentInput: () => true,
            onDropped,
            onFailure: vi.fn(),
            onPendingChange: (value) => pending.push(value),
            paste: (text) => {
                if (!controller.isPending()) pasted.push(text);
            },
            pasteAgentExact: (text, expectedLaunchId) => {
                expectedLaunchIds.push(expectedLaunchId);
                if (!controller.isPending()) pasted.push(text);
            },
            request: () => request.promise,
            threshold: () => 1_024,
        });

        expect(controller.intercept('original '.repeat(200))).toBe(true);
        expect(controller.isPending()).toBe(true);
        expect(controller.intercept('second long paste '.repeat(100))).toBe(true);
        expect(pending).toEqual([true]);
        expect(onDropped).toHaveBeenCalledOnce();
        request.resolve({
            agentLaunchId: 'launch-1',
            characterCount: 1_145,
            filePath: '/local/paste.txt',
            lineCount: 3,
            status: 'saved',
        });
        await vi.waitFor(() => expect(controller.isPending()).toBe(false));

        expect(pending).toEqual([true, false]);
        expect(expectedLaunchIds).toEqual(['launch-1']);
        expect(pasted[0]).not.toContain('original original');
        expect(pasted).toEqual([
            [
                '[Long paste saved locally]',
                'Original file: "/local/paste.txt"',
                'Original size: 3 lines, 1145 characters',
                '',
                'Read the original file for the exact content.',
                'If a summary is enough, delegate it to a subagent on a small, fast model so the full text stays out of this conversation.',
            ].join('\n'),
        ]);
    });

    it('tags only the synchronous xterm paste emission with the expected Agent process', () => {
        let observed: string | undefined;
        const route = new TerminalLongPasteInputRoute(() => {
            observed = route.expectedAgentLaunchId();
        });

        route.paste('saved paste reference', 'launch-2');

        expect(observed).toBe('launch-2');
        expect(route.expectedAgentLaunchId()).toBeUndefined();
    });

    it('never falls back to the original text when the Server request fails', async () => {
        const paste = vi.fn();
        const onFailure = vi.fn();
        const controller = new TerminalLongPasteController({
            canAcceptAgentInput: () => true,
            onDropped: vi.fn(),
            onFailure,
            paste,
            onPendingChange: vi.fn(),
            pasteAgentExact: paste,
            request: () => Promise.reject(new Error('save failed')),
            threshold: () => 1,
        });

        expect(controller.intercept('private original')).toBe(true);
        await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce());
        expect(paste).not.toHaveBeenCalled();
    });

    it('releases pending input when its Terminal controller is disposed', () => {
        const pending: boolean[] = [];
        const controller = new TerminalLongPasteController({
            canAcceptAgentInput: () => true,
            onDropped: vi.fn(),
            onFailure: vi.fn(),
            onPendingChange: (value) => pending.push(value),
            paste: vi.fn(),
            pasteAgentExact: vi.fn(),
            request: () => new Promise(() => {}),
            threshold: () => 1,
        });

        expect(controller.intercept('pending original')).toBe(true);
        controller.dispose();

        expect(controller.isPending()).toBe(false);
        expect(pending).toEqual([true, false]);
    });

    it('claims a context-menu paste before the asynchronous clipboard read can be overtaken', async () => {
        const clipboard = Promise.withResolvers<string>();
        const saved = Promise.withResolvers<SavedLongPaste>();
        const pending: boolean[] = [];
        const paste = vi.fn();
        const request = vi.fn(() => saved.promise);
        const onDropped = vi.fn();
        const controller = new TerminalLongPasteController({
            canAcceptAgentInput: () => true,
            onDropped,
            onFailure: vi.fn(),
            onPendingChange: (value) => pending.push(value),
            paste,
            pasteAgentExact: paste,
            request,
            threshold: () => 10,
        });

        const operation = controller.pasteFromClipboard(() => clipboard.promise);
        expect(controller.isPending()).toBe(true);
        expect(controller.intercept('overtaking input')).toBe(true);
        expect(onDropped).toHaveBeenCalledOnce();
        expect(request).not.toHaveBeenCalled();
        clipboard.resolve('long clipboard text');
        await vi.waitFor(() => expect(request).toHaveBeenCalledWith('long clipboard text'));
        expect(controller.isPending()).toBe(true);
        const result: SavedLongPaste = {
            agentLaunchId: 'launch-1',
            characterCount: 19,
            filePath: '/local/paste.txt',
            lineCount: 1,
            status: 'saved',
        };
        saved.resolve(result);
        await operation;

        expect(pending).toEqual([true, false]);
        expect(paste).toHaveBeenCalledExactlyOnceWith(formatLongPasteReference(result), 'launch-1');
    });

    it('drops and reports a second clipboard paste while one is still pending', async () => {
        const clipboard = Promise.withResolvers<string>();
        const onDropped = vi.fn();
        const paste = vi.fn();
        const controller = new TerminalLongPasteController({
            canAcceptAgentInput: () => true,
            onDropped,
            onFailure: vi.fn(),
            onPendingChange: vi.fn(),
            paste,
            pasteAgentExact: paste,
            request: () => new Promise(() => {}),
            threshold: () => 10,
        });

        const first = controller.pasteFromClipboard(() => clipboard.promise);
        expect(controller.isPending()).toBe(true);

        // A second paste arriving while the first is still pending must be dropped, not queued.
        await controller.pasteFromClipboard(() => Promise.resolve('overtaking clipboard text'));

        expect(onDropped).toHaveBeenCalledOnce();
        expect(paste).not.toHaveBeenCalled();

        clipboard.resolve('short');
        await first;
    });
});
