import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
    app: { getPath: vi.fn<(name: string) => string>() },
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
    app: electronMock.app,
    clipboard: electronMock.clipboard,
    ClipboardItem: electronMock.ClipboardItem,
    nativeImage: electronMock.nativeImage,
}));

import { createMainMethodHandler } from '../main-methods';
import type { ProcessExplorerWindowController } from '../process-explorer-window';
import type { DesktopServerConnection } from '../server-connection';
import type { UpdateService } from '../updates/updates';
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
        getCaxriBot: vi.fn(),
        revealSessionInWorkbench: () => Promise.resolve(),
        openSettingsInWorkbench: () => Promise.resolve(),
        getProcessExplorer: () => ({}) as ProcessExplorerWindowController,
        getRemoteDebugging: () => ({ port: '9223', transport: 'port' }) as const,
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
    electronMock.app.getPath.mockReset();
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

    it('attaches the screenshot to an idle Agent Chat message without touching the clipboard', async () => {
        const deliver = vi.fn(() => Promise.resolve(null));
        const request = requestWith(
            terminal({ lastProcessState: 'exited', processId: undefined, surface: 'chat' }),
            deliver,
        );
        const handle = handler(request);
        const chatImage = {
            data: 'Zm9v',
            mediaType: 'image/jpeg' as const,
            thumbnail: screenshot.dataUrl,
        };

        await handle({
            method: 'bugReport.send',
            params: {
                chatImage,
                report: 'issue',
                screenshot,
                sessionId: 'session-1',
                terminalId: 'terminal-1',
            },
        });
        expect(request).toHaveBeenCalledWith('bugReport.deliver', {
            images: [chatImage],
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

describe('bugReport.saveScreenshot', () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const dataUrl = `data:image/jpeg;base64,${jpegBytes.toString('base64')}`;
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    let temporaryRoot: string;

    beforeEach(async () => {
        temporaryRoot = await mkdtemp(join(tmpdir(), 'caxri-bug-report-test-'));
        electronMock.app.getPath.mockReturnValue(temporaryRoot);
    });

    afterEach(async () => {
        await rm(temporaryRoot, { force: true, recursive: true });
    });

    it('writes the original JPEG bytes and returns the saved path', async () => {
        const handle = handler(requestWith(undefined));

        const result = (await handle({
            method: 'bugReport.saveScreenshot',
            params: { dataUrl },
        })) as { path: string };

        expect(electronMock.app.getPath).toHaveBeenCalledWith('temp');
        expect(result.path.startsWith(join(temporaryRoot, 'caxri-bug-reports'))).toBe(true);
        expect(result.path.endsWith('.jpg')).toBe(true);
        await expect(readFile(result.path)).resolves.toEqual(jpegBytes);
        // The unredacted capture must not be readable by another account on a shared machine.
        expect((await stat(result.path)).mode & 0o777).toBe(0o600);
        expect((await stat(join(temporaryRoot, 'caxri-bug-reports'))).mode & 0o777).toBe(0o700);
        // The cheap SOI check replaced a full decode, so Electron is never asked to rasterize here.
        expect(electronMock.nativeImage.createFromDataURL).not.toHaveBeenCalled();
    });

    it('rejects base64 whose bytes are not a JPEG', async () => {
        const handle = handler(requestWith(undefined));

        await expect(
            handle({
                method: 'bugReport.saveScreenshot',
                params: {
                    dataUrl: `data:image/jpeg;base64,${Buffer.from('not-a-jpeg').toString('base64')}`,
                },
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        await expect(readdir(temporaryRoot)).resolves.toEqual([]);
    });

    it('prunes screenshots older than a day and keeps recent ones', async () => {
        const directory = join(temporaryRoot, 'caxri-bug-reports');
        await mkdir(directory, { recursive: true });
        const expired = join(directory, 'caxri-bug-report-expired.jpg');
        const recent = join(directory, 'caxri-bug-report-recent.jpg');
        await writeFile(expired, jpegBytes);
        await writeFile(recent, jpegBytes);
        await utimes(expired, yesterday, yesterday);
        const handle = handler(requestWith(undefined));

        const result = (await handle({
            method: 'bugReport.saveScreenshot',
            params: { dataUrl },
        })) as { path: string };

        const remaining = await readdir(directory);
        expect(remaining).not.toContain('caxri-bug-report-expired.jpg');
        expect(remaining).toContain('caxri-bug-report-recent.jpg');
        expect(remaining).toContain(result.path.slice(directory.length + 1));
    });

    it('never deletes an expired entry Caxri does not own', async () => {
        const directory = join(temporaryRoot, 'caxri-bug-reports');
        const foreignDirectory = join(directory, 'caxri-bug-report-folder.jpg');
        await mkdir(foreignDirectory, { recursive: true });
        const foreignFile = join(directory, 'notes.txt');
        await writeFile(foreignFile, 'unrelated');
        await utimes(foreignFile, yesterday, yesterday);
        await utimes(foreignDirectory, yesterday, yesterday);
        const handle = handler(requestWith(undefined));

        await handle({ method: 'bugReport.saveScreenshot', params: { dataUrl } });

        const remaining = await readdir(directory);
        expect(remaining).toContain('notes.txt');
        // A directory wearing a Caxri-shaped name is still not a Caxri screenshot.
        expect(remaining).toContain('caxri-bug-report-folder.jpg');
    });
});
