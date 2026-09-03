import { describe, expect, it, vi } from 'vitest';

import {
    formatLongPasteReference,
    shouldPrepareLongPaste,
    TerminalLongPasteController,
    TerminalLongPasteInputRoute,
} from '../terminal-long-paste';

describe('long Terminal paste', () => {
    it('triggers only above the configurable threshold for a running enabled Agent', () => {
        expect(
            shouldPrepareLongPaste({
                canAcceptAgentInput: true,
                enabled: true,
                text: 'x'.repeat(1_024),
                threshold: 1_024,
            }),
        ).toBe(false);
        expect(
            shouldPrepareLongPaste({
                canAcceptAgentInput: true,
                enabled: true,
                text: 'x'.repeat(1_025),
                threshold: 1_024,
            }),
        ).toBe(true);
        expect(
            shouldPrepareLongPaste({
                canAcceptAgentInput: false,
                enabled: true,
                text: 'x'.repeat(2_000),
                threshold: 1_024,
            }),
        ).toBe(false);
    });

    it('locks input synchronously and pastes only the summary and original file path', async () => {
        const pending: boolean[] = [];
        const pasted: string[] = [];
        const expectedLaunchIds: string[] = [];
        const request = Promise.withResolvers<{
            agentLaunchId: string;
            characterCount: number;
            filePath: string;
            lineCount: number;
            status: 'summarized';
            summary: string;
        }>();
        const onDropped = vi.fn();
        const controller = new TerminalLongPasteController({
            canAcceptAgentInput: () => true,
            enabled: () => true,
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
            status: 'summarized',
            summary: 'Actual failure: command exited with code 42.\n- src/task.ts:17',
        });
        await vi.waitFor(() => expect(controller.isPending()).toBe(false));

        expect(pending).toEqual([true, false]);
        expect(expectedLaunchIds).toEqual(['launch-1']);
        expect(pasted).toEqual([
            formatLongPasteReference({
                agentLaunchId: 'launch-1',
                characterCount: 1_145,
                filePath: '/local/paste.txt',
                lineCount: 3,
                status: 'summarized',
                summary: 'Actual failure: command exited with code 42.\n- src/task.ts:17',
            }),
        ]);
        expect(pasted[0]).not.toContain('original original');
        expect(pasted[0]).toBe(
            [
                '[Long paste saved locally]',
                'Original file: "/local/paste.txt"',
                'Original size: 3 lines, 1145 characters',
                '',
                'Summary:',
                'Actual failure: command exited with code 42.',
                '- src/task.ts:17',
                '',
                'Read the original file for exact details.',
            ].join('\n'),
        );
    });

    it('tags only the synchronous xterm paste emission with the expected Agent process', () => {
        let observed: string | undefined;
        const route = new TerminalLongPasteInputRoute(() => {
            observed = route.expectedAgentLaunchId();
        });

        route.paste('summary reference', 'launch-2');

        expect(observed).toBe('launch-2');
        expect(route.expectedAgentLaunchId()).toBeUndefined();
    });

    it('never falls back to the original text when the Server request fails', async () => {
        const paste = vi.fn();
        const onFailure = vi.fn();
        const controller = new TerminalLongPasteController({
            canAcceptAgentInput: () => true,
            enabled: () => true,
            onDropped: vi.fn(),
            onFailure,
            onPendingChange: vi.fn(),
            paste,
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
            enabled: () => true,
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
        const summary = Promise.withResolvers<{
            agentLaunchId: string;
            characterCount: number;
            filePath: string;
            lineCount: number;
            status: 'summarized';
            summary: string;
        }>();
        const pending: boolean[] = [];
        const paste = vi.fn();
        const request = vi.fn(() => summary.promise);
        const onDropped = vi.fn();
        const controller = new TerminalLongPasteController({
            canAcceptAgentInput: () => true,
            enabled: () => true,
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
        summary.resolve({
            agentLaunchId: 'launch-1',
            characterCount: 19,
            filePath: '/local/paste.txt',
            lineCount: 1,
            status: 'summarized',
            summary: 'Summary',
        });
        await operation;

        expect(pending).toEqual([true, false]);
        expect(paste).toHaveBeenCalledOnce();
        expect(paste).toHaveBeenCalledWith(
            formatLongPasteReference({
                agentLaunchId: 'launch-1',
                characterCount: 19,
                filePath: '/local/paste.txt',
                lineCount: 1,
                status: 'summarized',
                summary: 'Summary',
            }),
            'launch-1',
        );
    });

    it('drops and reports a second clipboard paste while one is still pending', async () => {
        const clipboard = Promise.withResolvers<string>();
        const onDropped = vi.fn();
        const paste = vi.fn();
        const controller = new TerminalLongPasteController({
            canAcceptAgentInput: () => true,
            enabled: () => true,
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

    it('formats the path-only fallback as readable lines with the original size', () => {
        expect(
            formatLongPasteReference({
                agentLaunchId: 'launch-1',
                characterCount: 2_048,
                filePath: '/local/paste.txt',
                lineCount: 1,
                status: 'unavailable',
            }),
        ).toBe(
            [
                '[Long paste saved locally; summary unavailable]',
                'Original file: "/local/paste.txt"',
                'Original size: 1 line, 2048 characters',
                '',
                'Read the original file for the exact content.',
            ].join('\n'),
        );
    });
});
