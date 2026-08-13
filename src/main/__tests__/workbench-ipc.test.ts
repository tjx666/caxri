import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
    const handles = new Map<string, (...args: unknown[]) => unknown>();
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    return {
        handles,
        listeners,
        ipcMain: {
            handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) =>
                handles.set(channel, handler),
            ),
            on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) =>
                listeners.set(channel, handler),
            ),
        },
    };
});

vi.mock('electron', () => ({ ipcMain: electronMock.ipcMain }));

import { installWorkbenchIpc } from '../workbench-ipc';

describe('workbench IPC sender boundary', () => {
    const renderer = {};
    const dispatch = vi.fn(() =>
        Promise.resolve({ protocolVersion: 1, id: 'r1', ok: true, result: null } as const),
    );
    const negotiate = vi.fn(() => ({
        protocolVersion: 1 as const,
        principal: { kind: 'desktop' as const, id: 'desktop-1' },
        capabilities: ['desktop' as const],
        commands: ['app.health'],
    }));

    beforeEach(() => {
        electronMock.handles.clear();
        electronMock.listeners.clear();
        dispatch.mockClear();
        negotiate.mockClear();
        installWorkbenchIpc({
            isQuitting: () => false,
            logger: () => undefined,
            renderer: () => renderer as never,
            transport: { dispatch, negotiate },
        });
    });

    it('retains sender validation for commands and negotiation', async () => {
        const request = electronMock.handles.get('caxri:request')!;
        const hello = electronMock.handles.get('caxri:negotiate')!;
        const envelope = { protocolVersion: 1, id: 'r1', method: 'app.health', params: {} };

        await expect(request({ sender: {} }, envelope)).resolves.toMatchObject({
            id: 'r1',
            ok: false,
            error: { code: 'PATH_DENIED' },
        });
        expect(() => hello({ sender: {} }, { supportedVersions: [1] })).toThrow(
            'Untrusted IPC sender',
        );
        await expect(request({ sender: renderer }, envelope)).resolves.toMatchObject({ ok: true });
        expect(hello({ sender: renderer }, { supportedVersions: [1] })).toMatchObject({
            protocolVersion: 1,
        });
    });
});
