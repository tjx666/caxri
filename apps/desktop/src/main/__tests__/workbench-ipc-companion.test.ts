import { RENDERER_DIAGNOSTIC_CHANNEL } from '@caxri/protocol';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
    const handles = new Map<string, (...arguments_: unknown[]) => unknown>();
    const listeners = new Map<string, (...arguments_: unknown[]) => unknown>();
    return {
        handles,
        listeners,
        ipcMain: {
            handle: vi.fn((channel: string, handler: (...arguments_: unknown[]) => unknown) =>
                handles.set(channel, handler),
            ),
            on: vi.fn((channel: string, handler: (...arguments_: unknown[]) => unknown) =>
                listeners.set(channel, handler),
            ),
        },
    };
});

vi.mock('electron', () => ({ ipcMain: electronMock.ipcMain }));

import { currentRequestWindow } from '../request-window';
import type { CompanionRendererPolicy } from '../workbench-ipc';
import { installWorkbenchIpc } from '../workbench-ipc';

describe('workbench IPC companion requests', () => {
    /**
     * A Main method that shows native UI must present it over the window that asked: the Agent Commander Terminal's
     * context menu opened over the Workbench instead.
     */
    it('runs a companion request in the companion window and a Workbench request in none', async () => {
        const renderer = {};
        const companionRenderer = {};
        const companionWindow = { isDestroyed: () => false };
        const seen: unknown[] = [];
        installWorkbenchIpc({
            isQuitting: () => false,
            isRecovering: () => false,
            logger: () => {},
            onEventsReady: vi.fn(),
            onRendererDiagnostic: vi.fn(),
            renderer: () => renderer as never,
            companion: (sender) =>
                sender === (companionRenderer as never)
                    ? {
                          rendererWindow: 'commander',
                          renderer: () => companionRenderer as never,
                          window: () => companionWindow as never,
                          admit: vi.fn(),
                          onEventsReady: vi.fn(),
                          onRendererError: vi.fn(),
                      }
                    : undefined,
            transport: {
                dispatch: vi.fn(() => {
                    seen.push(currentRequestWindow());
                    return Promise.resolve({
                        protocolVersion: 2,
                        id: 'r1',
                        ok: true,
                        result: null,
                    } as const);
                }),
                negotiate: vi.fn(),
            },
        });
        const request = electronMock.handles.get('caxri:request')!;
        const envelope = { protocolVersion: 2, id: 'r1', method: 'contextMenu.show', params: {} };

        await request({ sender: companionRenderer }, envelope);
        await request({ sender: renderer }, envelope);

        expect(seen).toEqual([companionWindow, undefined]);
    });

    /**
     * The Agent Commander and Benchmark windows are open together: each request is admitted by the policy of the window
     * that sent it, so one window's allowlist never widens or narrows the other's.
     */
    it('admits each companion request through its own window policy', async () => {
        const commanderRenderer = {} as WebContents;
        const benchmarkRenderer = {} as WebContents;
        const commanderAdmit = vi.fn();
        const benchmarkAdmit = vi.fn(() => {
            throw new Error('denied');
        });
        const companion = (
            rendererWindow: 'benchmark' | 'commander',
            renderer: WebContents,
            admit: () => void,
        ): CompanionRendererPolicy => ({
            rendererWindow,
            renderer: () => renderer,
            window: () => {},
            admit,
            onEventsReady: vi.fn(),
            onRendererError: vi.fn(),
        });
        const dispatch = vi.fn(() =>
            Promise.resolve({ protocolVersion: 2, id: 'r1', ok: true, result: null } as const),
        );
        installWorkbenchIpc({
            isQuitting: () => false,
            isRecovering: () => false,
            logger: () => {},
            renderer: () => {},
            companion: (sender) => {
                if (sender === commanderRenderer)
                    return companion('commander', commanderRenderer, commanderAdmit);
                if (sender === benchmarkRenderer)
                    return companion('benchmark', benchmarkRenderer, benchmarkAdmit);
                return;
            },
            transport: { dispatch, negotiate: vi.fn() },
        });
        const request = electronMock.handles.get('caxri:request')!;
        const envelope = { protocolVersion: 2, id: 'r1', method: 'commander.board', params: {} };

        const commanderReply = await request({ sender: commanderRenderer }, envelope);
        const benchmarkReply = await request({ sender: benchmarkRenderer }, envelope);

        expect(commanderReply).toMatchObject({ ok: true });
        expect(benchmarkReply).toMatchObject({ ok: false });
        expect(commanderAdmit).toHaveBeenCalledOnce();
        expect(benchmarkAdmit).toHaveBeenCalledOnce();
        expect(dispatch).toHaveBeenCalledOnce();
    });

    /**
     * The Agent Commander window mounts the same Terminal pane, so a WebGL failure there must reach the GPU log tagged
     * with its window; its startup frame is not the Workbench's and must not complete the Workbench startup profile.
     */
    it('accepts Terminal diagnostics from the companion as the commander window and ignores its startup frame', () => {
        const renderer = {};
        const companionRenderer = {};
        const onRendererDiagnostic = vi.fn();
        const onStartupFrame = vi.fn();
        const write = vi.fn();
        installWorkbenchIpc({
            isQuitting: () => false,
            isRecovering: () => false,
            logger: () => ({ write }) as never,
            onEventsReady: vi.fn(),
            onRendererDiagnostic,
            onStartupFrame,
            renderer: () => renderer as never,
            companion: (sender) =>
                sender === (companionRenderer as never)
                    ? {
                          rendererWindow: 'commander',
                          renderer: () => companionRenderer as never,
                          window: () => {},
                          admit: vi.fn(),
                          onEventsReady: vi.fn(),
                          onRendererError: vi.fn(),
                      }
                    : undefined,
            transport: { dispatch: vi.fn(), negotiate: vi.fn() },
        });
        const report = electronMock.listeners.get(RENDERER_DIAGNOSTIC_CHANNEL)!;
        const diagnostic = {
            kind: 'terminal-renderer',
            diagnosticId: '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae',
            terminalId: 'terminal-1',
            mode: 'dom',
            reason: 'context-loss',
            trigger: 'webgl-context-loss',
            preference: 'auto',
            contextLossCount: 1,
            redrawCount: 1,
            visibilityRestoreCoalescedCount: 0,
            liveWebglContextCount: 1,
            recoveryResult: 'dom-restored',
            retryAttemptCount: 0,
            retryDelayMs: 0,
            retryLimit: 3,
            retryState: 'idle',
            receivedBytes: 0,
            droppedBytes: 0,
            paneActive: true,
            terminalProcessRunning: true,
            agentTerminal: true,
            documentVisible: true,
            documentFocused: true,
            terminalFocused: true,
        };
        const osc52 = {
            kind: 'terminal-osc52-clipboard-write-failure',
            diagnosticId: 'bc3db163-6b13-4b50-81f4-126c55cc429b',
            terminalId: 'terminal-1',
            errorCategory: 'not-allowed',
            clipboardWritePermission: 'granted',
            documentVisible: true,
            documentFocused: true,
            secureContext: true,
            terminalFocused: true,
            userActivationActive: false,
            userActivationHasBeenActive: true,
        };

        report({ sender: companionRenderer }, diagnostic);
        report({ sender: companionRenderer }, osc52);
        const startupFrame = {
            kind: 'startup-frame',
            diagnosticId: '0b8d7a3e-6a0f-4b5e-9d55-3c1f1f3c2a10',
            timeOriginEpochMs: 1_700_000_000_000,
            loaderRemovedMs: 400,
            firstFrameMs: 420,
            documentVisible: true,
        };
        report({ sender: companionRenderer }, startupFrame);

        expect(onRendererDiagnostic).toHaveBeenCalledExactlyOnceWith(diagnostic, 'commander');
        expect(write).toHaveBeenCalledOnce();
        expect(write.mock.calls[0]).toMatchObject([
            'warn',
            'renderer.terminal_osc52_clipboard_write_failed',
            { fields: { code: 'TERMINAL_OSC52_CLIPBOARD_WRITE_FAILED', window: 'commander' } },
        ]);
        expect(onStartupFrame).not.toHaveBeenCalled();
        // The same frame from the Workbench is accepted, so the companion's was refused by sender, not by shape.
        report({ sender: renderer }, startupFrame);
        expect(onStartupFrame).toHaveBeenCalledExactlyOnceWith(startupFrame);
    });
});
