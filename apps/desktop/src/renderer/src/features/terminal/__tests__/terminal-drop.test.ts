import type { DragEvent } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    paste: vi.fn(() => true),
    toast: vi.fn(),
}));

vi.mock('../terminal-commands', () => ({ didPasteIntoTerminal: mocks.paste }));
vi.mock('../../../stores/toasts', () => ({ pushToast: mocks.toast }));

import { PROJECT_PATH_DRAG_TYPE } from '../../../lib/file-drag';
import { PANE_TAB_DRAG_TYPE } from '../../workbench/pane-drop-zone';
import { didPasteDropIntoTerminal, isTerminalPasteDrag } from '../terminal-drop';

const TERMINAL = {
    agentCwd: undefined,
    cwd: '/repo',
    id: 'terminal-1',
    lastAgentProcessState: undefined,
};

function drop(data: Record<string, string>, files: readonly string[] = []) {
    const event = {
        dataTransfer: {
            files: files.map((name) => ({ name })),
            getData: (type: string) => data[type] ?? '',
            types: [...Object.keys(data), ...(files.length > 0 ? ['Files'] : [])],
        },
        preventDefault: vi.fn(),
    };
    return event as typeof event & DragEvent;
}

beforeEach(() => {
    mocks.paste.mockClear();
    mocks.toast.mockClear();
    vi.stubGlobal('caxri', {
        pathForFile: (file: { name: string }) => (file.name.startsWith('/') ? file.name : ''),
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Terminal drops', () => {
    it('pastes files from Finder in one input, relative to the Terminal and quoted for the shell', () => {
        const event = drop({}, ['/repo/shot one.png', '/Volumes/Shots/two.png']);

        expect(didPasteDropIntoTerminal(event, TERMINAL)).toBe(true);

        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(mocks.paste).toHaveBeenCalledWith(
            'terminal-1',
            "'shot one.png' /Volumes/Shots/two.png",
        );
    });

    it('keeps a Project root absolute', () => {
        const event = drop({ [PROJECT_PATH_DRAG_TYPE]: '/repo' });

        didPasteDropIntoTerminal(event, TERMINAL);

        expect(mocks.paste).toHaveBeenCalledWith('terminal-1', '/repo');
    });

    it('explains a file with no path on disk instead of pasting nothing', () => {
        const event = drop({}, ['promise.png']);

        expect(didPasteDropIntoTerminal(event, TERMINAL)).toBe(false);

        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(mocks.paste).not.toHaveBeenCalled();
        expect(mocks.toast).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('no path on disk'),
        );
    });

    it('treats files and Caxri paths as pastes, but not a pane tab or plain text', () => {
        expect(isTerminalPasteDrag(drop({}, ['/Volumes/Shots/two.png']))).toBe(true);
        expect(isTerminalPasteDrag(drop({ [PROJECT_PATH_DRAG_TYPE]: '/repo' }))).toBe(true);
        expect(isTerminalPasteDrag(drop({ [PANE_TAB_DRAG_TYPE]: 'tab-1' }))).toBe(false);
        expect(isTerminalPasteDrag(drop({ 'text/plain': 'hello' }))).toBe(false);
    });
});
