import { CaxriError } from '@caxri/protocol';
import type { Terminal } from '@xterm/xterm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TerminalLinkHint from '../terminal-link-hint';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve(undefined)),
    hintShow: vi.fn(),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));
/**
 * Records what a hover hands the hint, so a test can see whether a reference card would load details.
 */
vi.mock('../terminal-link-hint', async (importOriginal) => ({
    ...(await importOriginal<typeof TerminalLinkHint>()),
    createTerminalLinkHintController: () => ({
        dispose: vi.fn(),
        hide: vi.fn(),
        isLinkHovered: () => false,
        leave: vi.fn(),
        show: mocks.hintShow,
    }),
}));

import { dismissToast, getToasts } from '../../../stores/toasts';
import { TERMINAL_DEFAULT_WORD_SEPARATORS } from '../terminal-file-candidate';
import { canSendTerminalInput, didPasteIntoTerminal } from '../terminal-pane-handlers';
import { configureTerminalPaneHost, terminalPaneHost } from '../terminal-pane-host';
import {
    opaqueSearchColor,
    registerTerminalInputHandlers,
    registerTerminalPaneLinks,
    reportTerminalOperationError,
    xtermThemeWithoutOverviewRulerBorder,
} from '../terminal-pane-support';
import { terminalSurfaceSwitches } from '../terminal-surface-switch-pending';
import { cellsFor, createTerminal } from './terminal-links-test-helpers';

const workbenchHost = terminalPaneHost();

beforeEach(() => {
    configureTerminalPaneHost(workbenchHost);
    dismissToast();
    mocks.caxriRequest.mockReset();
    mocks.caxriRequest.mockResolvedValue(undefined);
});

describe('opaqueSearchColor', () => {
    it('strips the trailing alpha byte from an 8-digit hex color', () => {
        expect(opaqueSearchColor('#282836ff')).toBe('#282836');
    });

    it('leaves an already-opaque 6-digit hex color unchanged', () => {
        expect(opaqueSearchColor('#282836')).toBe('#282836');
    });
});

describe('xtermThemeWithoutOverviewRulerBorder', () => {
    it('preserves Terminal colors while making xterm overview ruler border transparent', () => {
        expect(
            xtermThemeWithoutOverviewRulerBorder({
                background: '#101820',
                foreground: '#f8f8f2',
                overviewRulerBorder: '#ff0000',
            }),
        ).toEqual({
            background: '#101820',
            foreground: '#f8f8f2',
            overviewRulerBorder: 'transparent',
        });
    });
});

describe('reportTerminalOperationError', () => {
    it('ignores typed lifecycle cancellation regardless of its message', () => {
        reportTerminalOperationError(
            new CaxriError('CANCELLED', 'Fixture cancelled'),
            'terminal.errors.attachFailed',
        );
        expect(getToasts()).toEqual([]);
    });

    it.each(['UNAVAILABLE', 'TIMEOUT', 'NOT_FOUND'] as const)(
        'preserves real %s failures',
        (code) => {
            reportTerminalOperationError(
                new CaxriError(code, 'Fixture failed'),
                'terminal.errors.attachFailed',
            );
            expect(getToasts().map((toast) => toast.title)).toEqual(['Fixture failed']);
        },
    );

    it('does not classify untyped errors by message', () => {
        reportTerminalOperationError(
            new Error('Terminal stream operation was cancelled'),
            'terminal.errors.attachFailed',
        );
        expect(getToasts().map((toast) => toast.title)).toEqual([
            'Terminal stream operation was cancelled',
        ]);
    });
});

describe('registerTerminalInputHandlers', () => {
    it.each([false, true])(
        'does not notify for cancelled input (disposed: %s)',
        async (disposed) => {
            let onData: ((data: string) => void) | undefined;
            const pending = Promise.withResolvers<unknown>();
            mocks.caxriRequest.mockReturnValueOnce(pending.promise);
            const terminal = {
                onBinary: () => ({ dispose: vi.fn() }),
                onData: (handler: (data: string) => void) => {
                    onData = handler;
                    return { dispose: vi.fn() };
                },
            } as unknown as Terminal;
            const unregister = registerTerminalInputHandlers(
                terminal,
                'cancelled-input',
                () => true,
            );
            onData?.('fixture');
            if (disposed) unregister();
            pending.reject(new CaxriError('CANCELLED', 'Terminal stream operation was cancelled'));
            await expect(pending.promise).rejects.toMatchObject({ code: 'CANCELLED' });
            expect(getToasts()).toEqual([]);
            if (!disposed) unregister();
        },
    );

    it.each([false, true])(
        'reports real input failures only to the live pane (disposed: %s)',
        async (disposed) => {
            let onData: ((data: string) => void) | undefined;
            const pending = Promise.withResolvers<unknown>();
            mocks.caxriRequest.mockReturnValueOnce(pending.promise);
            const terminal = {
                onBinary: () => ({ dispose: vi.fn() }),
                onData: (handler: (data: string) => void) => {
                    onData = handler;
                    return { dispose: vi.fn() };
                },
            } as unknown as Terminal;
            const unregister = registerTerminalInputHandlers(terminal, 'failed-input', () => true);
            onData?.('fixture');
            if (disposed) unregister();
            pending.reject(new CaxriError('UNAVAILABLE', 'Fixture transport failed'));
            await expect(pending.promise).rejects.toMatchObject({ code: 'UNAVAILABLE' });
            expect(getToasts().map((toast) => toast.title)).toEqual(
                disposed ? [] : ['Fixture transport failed'],
            );
            if (!disposed) unregister();
        },
    );

    it('routes typed and dropped input through one live xterm path', async () => {
        let onData: ((data: string) => void) | undefined;
        const dataDisposable = { dispose: vi.fn() };
        const focus = vi.fn();
        const paste = vi.fn();
        const terminal = {
            focus,
            onBinary: () => ({ dispose: vi.fn() }),
            onData: vi.fn((handler: (data: string) => void) => {
                onData = handler;
                return dataDisposable;
            }),
            paste,
        } as unknown as Terminal;
        const unregister = registerTerminalInputHandlers(terminal, 'terminal-input-1', () => true);

        onData?.('typed input');
        await vi.waitFor(() =>
            expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.input', {
                terminalId: 'terminal-input-1',
                data: 'typed input',
            }),
        );
        expect(didPasteIntoTerminal('terminal-input-1', "'/repo/a file.txt'")).toBe(true);
        expect(paste).toHaveBeenCalledWith("'/repo/a file.txt'");
        expect(focus).toHaveBeenCalledTimes(1);

        unregister();
        expect(dataDisposable.dispose).toHaveBeenCalledTimes(1);
        expect(didPasteIntoTerminal('terminal-input-1', '/repo/ignored')).toBe(false);
    });

    it('rejects typed and dropped input when the Terminal is stopped', () => {
        let onData: ((data: string) => void) | undefined;
        const paste = vi.fn();
        const terminal = {
            focus: vi.fn(),
            onBinary: () => ({ dispose: vi.fn() }),
            onData: vi.fn((handler: (data: string) => void) => {
                onData = handler;
                return { dispose: vi.fn() };
            }),
            paste,
        } as unknown as Terminal;
        const unregister = registerTerminalInputHandlers(terminal, 'terminal-input-2', () => false);

        onData?.('ignored input');

        expect(canSendTerminalInput('terminal-input-2')).toBe(false);
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
        expect(didPasteIntoTerminal('terminal-input-2', '/repo/ignored')).toBe(false);
        expect(paste).not.toHaveBeenCalled();
        unregister();
        expect(canSendTerminalInput('terminal-input-2')).toBe(true);
    });

    it('drops xterm query replies while the running Terminal is switching to Chat', async () => {
        let onData: ((data: string) => void) | undefined;
        let onBinary: ((data: string) => void) | undefined;
        const paste = vi.fn();
        const terminal = {
            focus: vi.fn(),
            onBinary: vi.fn((handler: (data: string) => void) => {
                onBinary = handler;
                return { dispose: vi.fn() };
            }),
            onData: vi.fn((handler: (data: string) => void) => {
                onData = handler;
                return { dispose: vi.fn() };
            }),
            paste,
        } as unknown as Terminal;
        const unregister = registerTerminalInputHandlers(terminal, 'terminal-to-chat', () => true);
        const switched = Promise.withResolvers<undefined>();
        const switching = terminalSurfaceSwitches.run(
            'terminal-to-chat',
            'chat',
            () => switched.promise,
        );

        // A primary device attributes reply and a cursor position report, as xterm emits them for the final PTY output.
        onData?.('\u{1B}[?1;2c');
        onData?.('\u{1B}[12;1R');
        onBinary?.('\u{1B}[M !!');

        expect(canSendTerminalInput('terminal-to-chat')).toBe(false);
        expect(didPasteIntoTerminal('terminal-to-chat', '/repo/ignored')).toBe(false);
        expect(paste).not.toHaveBeenCalled();
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
        expect(getToasts()).toEqual([]);

        switched.resolve(undefined);
        await switching;
        onData?.('typed input');
        await vi.waitFor(() =>
            expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.input', {
                terminalId: 'terminal-to-chat',
                data: 'typed input',
            }),
        );
        unregister();
    });

    it('keeps input open while the Terminal is switching away from Chat', async () => {
        let onData: ((data: string) => void) | undefined;
        const terminal = {
            onBinary: () => ({ dispose: vi.fn() }),
            onData: vi.fn((handler: (data: string) => void) => {
                onData = handler;
                return { dispose: vi.fn() };
            }),
        } as unknown as Terminal;
        const unregister = registerTerminalInputHandlers(terminal, 'terminal-to-pty', () => true);
        const switched = Promise.withResolvers<undefined>();
        const switching = terminalSurfaceSwitches.run(
            'terminal-to-pty',
            'pty',
            () => switched.promise,
        );

        onData?.('typed input');
        await vi.waitFor(() =>
            expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.input', {
                terminalId: 'terminal-to-pty',
                data: 'typed input',
            }),
        );
        switched.resolve(undefined);
        await switching;
        unregister();
    });

    it('tags a generated paste with the Agent process expected by the Server', async () => {
        let onData: ((data: string) => void) | undefined;
        const terminal = {
            onBinary: () => ({ dispose: vi.fn() }),
            onData: vi.fn((handler: (data: string) => void) => {
                onData = handler;
                return { dispose: vi.fn() };
            }),
        } as unknown as Terminal;
        const unregister = registerTerminalInputHandlers(
            terminal,
            'terminal-input-exact',
            () => true,
            () => 'launch-1',
        );

        onData?.('summary reference');

        await vi.waitFor(() =>
            expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.inputAgentExact', {
                terminalId: 'terminal-input-exact',
                data: 'summary reference',
                expectedAgentLaunchId: 'launch-1',
            }),
        );
        unregister();
    });

    it('forwards xterm binary mouse input without converting its high bytes to text', async () => {
        let onBinary: ((data: string) => void) | undefined;
        const binaryDisposable = { dispose: vi.fn() };
        const terminal = {
            onData: vi.fn(() => ({ dispose: vi.fn() })),
            onBinary: vi.fn((handler: (data: string) => void) => {
                onBinary = handler;
                return binaryDisposable;
            }),
        } as unknown as Terminal;
        const unregister = registerTerminalInputHandlers(
            terminal,
            'mouse-terminal',
            () => true,
            () => 'launch-1',
        );

        onBinary?.('\u{1B}[M \u{80}\u{FF}');
        await vi.waitFor(() =>
            expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.inputBinary', {
                terminalId: 'mouse-terminal',
                data: '\u{1B}[M \u{80}\u{FF}',
                expectedAgentLaunchId: 'launch-1',
            }),
        );
        unregister();
        expect(binaryDisposable.dispose).toHaveBeenCalledOnce();
    });
});

describe('registerTerminalPaneLinks', () => {
    const text = 'src/file.ts:12 f36a02ac https://example.com/plain';

    async function paneLinks(line: string) {
        const terminal = createTerminal(line, cellsFor(line));
        const registration = registerTerminalPaneLinks(terminal.terminal, () => ({
            referenceContext: {
                githubRepositories: [{ owner: 'example', repo: 'project' }],
                rules: [],
            },
            terminalId: 'terminal-1',
            wordSeparators: TERMINAL_DEFAULT_WORD_SEPARATORS,
        }));
        try {
            return (await terminal.links()) ?? [];
        } finally {
            registration.dispose();
        }
    }

    async function linkedTexts(): Promise<string[]> {
        return (await paneLinks(text)).map((link) => link.text);
    }

    async function hoveredReferencePreview() {
        mocks.hintShow.mockClear();
        const [reference] = await paneLinks('example/project#12');
        reference.hover?.({} as MouseEvent, reference.text);
        expect(mocks.hintShow).toHaveBeenCalledOnce();
        return mocks.hintShow.mock.lastCall?.[4] as { load?: unknown } | undefined;
    }

    it('links files, commits, and URLs in the Workbench', async () => {
        expect(await linkedTexts()).toEqual([
            'src/file.ts:12',
            'f36a02ac',
            'https://example.com/plain',
        ]);
    });

    it('links files and URLs but not commits in a window whose host has no Workbench Git view', async () => {
        configureTerminalPaneHost({ openSettings: vi.fn(), hasWorkbenchLinks: false });

        expect(await linkedTexts()).toEqual(['src/file.ts:12', 'https://example.com/plain']);
    });

    it('opens a clicked file link through the ordinary Workbench request', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({ opened: true });
        const links = await paneLinks(text);

        links[0].activate({ metaKey: true } as MouseEvent, links[0].text);
        await Promise.resolve();

        expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.openFileLink', {
            terminalId: 'terminal-1',
            target: 'src/file.ts',
            location: { mode: 'line', startLine: 12, endLine: 12 },
        });
    });

    it("opens a clicked file link through the Commander's own request in a window with no Workbench editor", async () => {
        configureTerminalPaneHost({ openSettings: vi.fn(), hasWorkbenchLinks: false });
        mocks.caxriRequest.mockResolvedValueOnce({ opened: true });
        const links = await paneLinks(text);

        links[0].activate({ metaKey: true } as MouseEvent, links[0].text);
        await Promise.resolve();

        expect(mocks.caxriRequest).toHaveBeenCalledWith('agentCommander.openFileLink', {
            terminalId: 'terminal-1',
            target: 'src/file.ts',
            location: { mode: 'line', startLine: 12, endLine: 12 },
        });
    });

    it('loads reference hover details only where the Workbench can answer them', async () => {
        expect((await hoveredReferencePreview())?.load).toEqual(expect.any(Function));

        configureTerminalPaneHost({ openSettings: vi.fn(), hasWorkbenchLinks: false });

        const preview = await hoveredReferencePreview();
        expect(preview).toBeDefined();
        expect(preview?.load).toBeUndefined();
    });
});
