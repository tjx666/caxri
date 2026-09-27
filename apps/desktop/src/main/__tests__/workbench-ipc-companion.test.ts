import { describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
    const handles = new Map<string, (...arguments_: unknown[]) => unknown>();
    return {
        handles,
        ipcMain: {
            handle: vi.fn((channel: string, handler: (...arguments_: unknown[]) => unknown) =>
                handles.set(channel, handler),
            ),
            on: vi.fn(),
        },
    };
});

vi.mock('electron', () => ({ ipcMain: electronMock.ipcMain }));

import { currentRequestWindow } from '../request-window';
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
            companion: {
                renderer: () => companionRenderer as never,
                window: () => companionWindow as never,
                admit: vi.fn(),
                onEventsReady: vi.fn(),
                onRendererError: vi.fn(),
            },
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
});
