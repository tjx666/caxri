import { Buffer } from 'node:buffer';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
    clipboard: {
        write: vi.fn<(items: Array<{ items: Record<string, unknown> }>) => Promise<void>>(),
    },
    ClipboardItem: vi.fn(
        class ClipboardItemMock {
            constructor(readonly items: Record<string, unknown>) {}
        },
    ),
    nativeImage: { createFromDataURL: vi.fn() },
}));
vi.mock('electron', () => ({
    clipboard: electronMock.clipboard,
    ClipboardItem: electronMock.ClipboardItem,
    nativeImage: electronMock.nativeImage,
}));

import { createMainMethodHandler } from '../main-methods';
import type { ProcessExplorerWindowController } from '../process-explorer-window';
import type { DesktopServerConnection } from '../server-connection';
import type { UpdateService } from '../updates';
import type { createWorkbenchRootAuthority } from '../workbench-root-authority';

const screenshot = { dataUrl: 'data:image/jpeg;base64,Zm9v', height: 10, width: 20 };

function terminal(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: 'terminal-1',
        sessionId: 'session-1',
        provider: 'codex',
        lastProcessState: 'running',
        processId: 100,
        ...overrides,
    };
}

function handler(
    request: (method: string, parameters?: unknown) => Promise<unknown>,
    window?: unknown,
) {
    return createMainMethodHandler({
        getProcessExplorer: () => ({}) as ProcessExplorerWindowController,
        getUserDataPath: () => '/user-data',
        getSupervisor: () => ({ request }) as unknown as DesktopServerConnection,
        getUpdateService: () => ({}) as UpdateService,
        getWindow: () => window as never,
        workbenchRootAuthority: {} as ReturnType<typeof createWorkbenchRootAuthority>,
    });
}

function requestWith(terminalRecord: unknown, deliver = vi.fn(() => Promise.resolve(null))) {
    return vi.fn((method: string) => {
        if (method === 'app.records')
            return Promise.resolve({
                sessions: [],
                terminals: terminalRecord ? [terminalRecord] : [],
            });
        if (method === 'bugReport.deliver') return deliver();
        return Promise.reject(new Error(`Unexpected method: ${method}`));
    });
}

beforeEach(() => {
    electronMock.clipboard.write.mockReset();
    electronMock.clipboard.write.mockResolvedValue(undefined);
    electronMock.ClipboardItem.mockClear();
    electronMock.nativeImage.createFromDataURL.mockReset();
});

describe('bugReport.send validation', () => {
    it('rejects when the Agent Terminal no longer exists', async () => {
        const handle = handler(requestWith(undefined));

        await expect(
            handle({
                method: 'bugReport.send',
                params: { report: 'issue', sessionId: 'session-1', terminalId: 'terminal-1' },
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects when the Terminal belongs to a different Session', async () => {
        const handle = handler(requestWith(terminal({ sessionId: 'session-other' })));

        await expect(
            handle({
                method: 'bugReport.send',
                params: { report: 'issue', sessionId: 'session-1', terminalId: 'terminal-1' },
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('rejects a non-Agent Terminal', async () => {
        const handle = handler(requestWith(terminal({ provider: undefined })));

        await expect(
            handle({
                method: 'bugReport.send',
                params: { report: 'issue', sessionId: 'session-1', terminalId: 'terminal-1' },
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it.each([
        ['stopped Agent', { lastProcessState: 'exited', processId: 100 }],
        ['missing process id', { lastProcessState: 'running', processId: undefined }],
    ])('rejects a %s', async (_label, overrides) => {
        const handle = handler(requestWith(terminal(overrides)));

        await expect(
            handle({
                method: 'bugReport.send',
                params: { report: 'issue', sessionId: 'session-1', terminalId: 'terminal-1' },
            }),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });
});

describe('bugReport.send screenshot delivery gating', () => {
    it('delivers without a screenshot when none was captured', async () => {
        const deliver = vi.fn(() => Promise.resolve(null));
        const request = requestWith(terminal(), deliver);
        const handle = handler(request);

        await handle({
            method: 'bugReport.send',
            params: { report: 'issue', sessionId: 'session-1', terminalId: 'terminal-1' },
        });
        expect(request).toHaveBeenCalledWith('bugReport.deliver', {
            pasteImage: false,
            report: 'issue',
            sessionId: 'session-1',
            terminalId: 'terminal-1',
        });
        expect(electronMock.nativeImage.createFromDataURL).not.toHaveBeenCalled();
        expect(electronMock.clipboard.write).not.toHaveBeenCalled();
    });

    it('never touches the clipboard for a provider without clipboard image input', async () => {
        const deliver = vi.fn(() => Promise.resolve(null));
        const request = requestWith(terminal({ provider: 'claude' }), deliver);
        const handle = handler(request);

        await handle({
            method: 'bugReport.send',
            params: {
                report: 'issue',
                screenshot,
                sessionId: 'session-1',
                terminalId: 'terminal-1',
            },
        });
        expect(request).toHaveBeenCalledWith('bugReport.deliver', {
            pasteImage: false,
            report: 'issue',
            sessionId: 'session-1',
            terminalId: 'terminal-1',
        });
        expect(electronMock.nativeImage.createFromDataURL).not.toHaveBeenCalled();
        expect(electronMock.clipboard.write).not.toHaveBeenCalled();
    });

    it('rejects an invalid captured screenshot before touching the clipboard', async () => {
        const image = { isEmpty: () => true };
        electronMock.nativeImage.createFromDataURL.mockReturnValueOnce(image);
        const request = requestWith(terminal({ provider: 'codex' }));
        const handle = handler(request);

        await expect(
            handle({
                method: 'bugReport.send',
                params: {
                    report: 'issue',
                    screenshot,
                    sessionId: 'session-1',
                    terminalId: 'terminal-1',
                },
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        expect(electronMock.clipboard.write).not.toHaveBeenCalled();
    });

    it('writes a valid screenshot to the clipboard and flags the report as a paste image', async () => {
        const image = { isEmpty: () => false, toPNG: () => Buffer.from('png') };
        electronMock.nativeImage.createFromDataURL.mockReturnValueOnce(image);
        const deliver = vi.fn(() => Promise.resolve(null));
        const request = requestWith(terminal({ provider: 'codex' }), deliver);
        const handle = handler(request);

        await handle({
            method: 'bugReport.send',
            params: {
                report: 'issue',
                screenshot,
                sessionId: 'session-1',
                terminalId: 'terminal-1',
            },
        });
        expect(electronMock.nativeImage.createFromDataURL).toHaveBeenCalledWith(screenshot.dataUrl);
        const clipboardPayload = electronMock.ClipboardItem.mock.calls[0]?.[0];
        expect(clipboardPayload['image/png']).toBeInstanceOf(Blob);
        expect(electronMock.clipboard.write).toHaveBeenCalledWith([{ items: clipboardPayload }]);
        expect(request).toHaveBeenCalledWith('bugReport.deliver', {
            pasteImage: true,
            report: 'issue',
            sessionId: 'session-1',
            terminalId: 'terminal-1',
        });
    });

    it('does not deliver the report when Electron rejects the asynchronous clipboard write', async () => {
        const image = { isEmpty: () => false, toPNG: () => Buffer.from('png') };
        electronMock.nativeImage.createFromDataURL.mockReturnValueOnce(image);
        electronMock.clipboard.write.mockRejectedValueOnce(new Error('clipboard denied'));
        const deliver = vi.fn(() => Promise.resolve(null));
        const handle = handler(requestWith(terminal({ provider: 'codex' }), deliver));

        await expect(
            handle({
                method: 'bugReport.send',
                params: {
                    report: 'issue',
                    screenshot,
                    sessionId: 'session-1',
                    terminalId: 'terminal-1',
                },
            }),
        ).rejects.toThrow('clipboard denied');
        expect(deliver).not.toHaveBeenCalled();
    });
});

describe('bugReport.captureScreenshot', () => {
    it('rejects when there is no Caxri window', async () => {
        const handle = handler(requestWith(undefined), undefined);

        await expect(
            handle({ method: 'bugReport.captureScreenshot', params: {} }),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('rejects when the Caxri window has already been destroyed', async () => {
        const handle = handler(requestWith(undefined), {
            isDestroyed: () => true,
        });

        await expect(
            handle({ method: 'bugReport.captureScreenshot', params: {} }),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('captures and JPEG-encodes the current window contents', async () => {
        const capturePage = vi.fn(() =>
            Promise.resolve({
                getSize: () => ({ height: 10, width: 20 }),
                toJPEG: () => ({ toString: () => 'ZmFrZS1qcGVn' }),
            }),
        );
        const handle = handler(requestWith(undefined), {
            isDestroyed: () => false,
            webContents: { capturePage },
        });

        await expect(
            handle({ method: 'bugReport.captureScreenshot', params: {} }),
        ).resolves.toEqual({
            dataUrl: 'data:image/jpeg;base64,ZmFrZS1qcGVn',
            height: 10,
            width: 20,
        });
        expect(capturePage).toHaveBeenCalledOnce();
    });
});
