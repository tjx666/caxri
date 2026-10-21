import { RENDERER_DIAGNOSTIC_CHANNEL } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
    const listeners = new Map<string, (...arguments_: unknown[]) => unknown>();
    return {
        listeners,
        ipcMain: {
            handle: vi.fn(),
            on: vi.fn((channel: string, handler: (...arguments_: unknown[]) => unknown) =>
                listeners.set(channel, handler),
            ),
        },
    };
});

vi.mock('electron', () => ({ ipcMain: electronMock.ipcMain }));

import { installWorkbenchIpc } from '../workbench-ipc';

const transport = {
    dispatch: vi.fn(() =>
        Promise.resolve({ protocolVersion: 2, id: 'r1', ok: true, result: null } as const),
    ),
    negotiate: vi.fn(),
};

/**
 * The shape from issue #962: Monaco kept asking for Workers, four of them never ran their script, and the probe Worker
 * was silent on both return paths while the Renderer's own timers stayed exact.
 */
const stalledDiff = {
    kind: 'editor-worker-stall',
    diagnosticId: 'f0d9f3f6-6a6f-4f1a-9d84-3d40aa6ec6ad',
    surface: 'git-diff',
    outcome: 'timeout',
    waitMs: 10_009,
    workerRoundTrip: 'no-reply',
    workerRoundTripMs: null,
    workerBroadcast: 'no-reply',
    documentVisible: true,
    navigationType: 'reload',
    pageAgeMs: 36_928_141,
    originalLineCount: 120,
    modifiedLineCount: 165,
    identicalModels: false,
    diffOpenCount: 33,
    stallCount: 3,
    editorWorkersCreated: 58,
    editorWorkersStarted: 54,
    editorWorkersStartupStalled: 4,
    editorWorkersStartupStalledNow: 1,
};

describe('editor Worker stall diagnostic', () => {
    const renderer = {};
    const write =
        vi.fn<
            (level: string, event: string, record: { fields: Record<string, unknown> }) => void
        >();

    beforeEach(() => {
        electronMock.listeners.clear();
        write.mockClear();
    });

    function install(readEventLoopStalls?: () => ReturnType<typeof summary>) {
        installWorkbenchIpc({
            isQuitting: () => false,
            isRecovering: () => false,
            logger: () => ({ write }) as never,
            readEventLoopStalls,
            isWorkbenchSender: (sender) => sender === (renderer as never),
            transport,
        });
        return electronMock.listeners.get(RENDERER_DIAGNOSTIC_CHANNEL)!;
    }

    const summary = () => ({
        blockCount: 2,
        longestBlockMs: 4200,
        msSinceLastBlock: 1500,
        suspensionCount: 7,
    });

    /**
     * A Renderer cannot see the process that creates its Workers, loads their scripts out of `app.asar`, and brokers
     * their `BroadcastChannel`s, so Main's own loop state is stamped onto this record rather than left for a reader to
     * join across two logs by timestamp, a join that fails outright once the other record is rotated away.
     */
    it('stamps a stalled diff with what the Main event loop was doing', () => {
        const report = install(summary);

        report({ sender: renderer }, stalledDiff);

        expect(write).toHaveBeenCalledOnce();
        expect(write.mock.calls[0]?.slice(0, 2)).toEqual(['warn', 'renderer.editor_worker_stall']);
        expect(write.mock.calls[0]?.[2].fields).toMatchObject({
            editorWorkersCreated: 58,
            editorWorkersStarted: 54,
            editorWorkersStartupStalled: 4,
            editorWorkersStartupStalledNow: 1,
            mainEventLoopBlockCount: 2,
            mainEventLoopLongestBlockMs: 4200,
            mainEventLoopMsSinceLastBlock: 1500,
            mainEventLoopSuspensionCount: 7,
        });
    });

    it('records the Renderer stall even when no Main loop measurement exists', () => {
        const report = install();

        report({ sender: renderer }, stalledDiff);

        expect(write).toHaveBeenCalledOnce();
        expect(write.mock.calls[0]?.[2].fields).toMatchObject({
            // Absent, not zero: nothing measured the loop, which is a different claim from "it never blocked".
            mainEventLoopBlockCount: null,
            mainEventLoopLongestBlockMs: null,
            mainEventLoopMsSinceLastBlock: null,
            mainEventLoopSuspensionCount: null,
        });
    });

    it('rejects a stall report from an untrusted sender', () => {
        const report = install(summary);

        report({ sender: {} }, stalledDiff);

        expect(write).not.toHaveBeenCalled();
    });
});
