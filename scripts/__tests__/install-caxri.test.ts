import { describe, expect, it, vi } from 'vitest';

import {
    findDmgPair,
    isHeadlessCaxriProcess,
    parseArguments,
    quitRunningCaxri,
} from '../install-caxri';

const GUI = { command: '/Applications/Caxri.app/Contents/MacOS/Caxri', pid: 100 };
const HOST = {
    command:
        '/Applications/Caxri.app/Contents/Resources/server/runtime/bin/node /Applications/Caxri.app/Contents/Resources/server/bundles/host.js',
    pid: 200,
};

interface FakeProcess {
    command: string;
    pid: number;
}

/**
 * Models the installed bundle's live processes so a test states which of them each shutdown mechanism can actually
 * stop. The Apple event reaches only the windowed application; a signal reaches anything that is not pinned as
 * unstoppable. `wait` resolves immediately, so the bounded polling loops cost no real time.
 */
function quitHarness(processes: FakeProcess[], unstoppable: number[] = []) {
    const alive = new Map(processes.map((entry) => [entry.pid, entry]));
    const signalled: number[] = [];
    const quitApp = vi.fn(() => {
        for (const [pid, entry] of alive) {
            if (!isHeadlessCaxriProcess(entry.command)) alive.delete(pid);
        }
        return Promise.resolve();
    });
    return {
        quitApplication: quitApp,
        signalled,
        operations: {
            list: () => Promise.resolve(alive.values().toArray()),
            quitApplication: quitApp,
            signalProcess: (pid: number) => {
                signalled.push(pid);
                if (!unstoppable.includes(pid)) alive.delete(pid);
            },
            wait: async () => {},
        },
    };
}

describe('install-caxri', () => {
    it('parses an optional release tag and rejects unknown arguments', () => {
        expect(parseArguments([])).toEqual({});
        expect(parseArguments(['--tag', 'v0.0.7'])).toEqual({ tag: 'v0.0.7' });
        expect(() => parseArguments(['--nope'])).toThrow('Unknown argument');
        expect(() => parseArguments(['--tag'])).toThrow('Unknown argument');
    });

    it('pairs the downloaded DMG with its checksum companion', () => {
        expect(findDmgPair(['Caxri-0.0.7-arm64.dmg', 'Caxri-0.0.7-arm64.dmg.sha256'])).toEqual({
            checksum: 'Caxri-0.0.7-arm64.dmg.sha256',
            dmg: 'Caxri-0.0.7-arm64.dmg',
        });
        expect(findDmgPair(['Caxri-0.0.7-arm64.dmg'])).toEqual({
            checksum: undefined,
            dmg: 'Caxri-0.0.7-arm64.dmg',
        });
        expect(findDmgPair(['README.md'])).toBeUndefined();
    });

    it('separates the detached Server from the windowed application', () => {
        expect(isHeadlessCaxriProcess(HOST.command)).toBe(true);
        expect(isHeadlessCaxriProcess(GUI.command)).toBe(false);
        expect(isHeadlessCaxriProcess(`${GUI.command} --enable-features=Foo`)).toBe(false);
    });

    it('signals a Server that no Apple event can reach', async () => {
        // The regression: once the last window closes, the bundle still runs its detached background
        // processes. Waiting out an Apple event nothing receives failed every installer run.
        const harness = quitHarness([HOST]);
        await quitRunningCaxri(harness.operations);
        expect(harness.quitApplication).not.toHaveBeenCalled();
        expect(harness.signalled).toEqual([HOST.pid]);
    });

    it('lets the windowed application quit on its own before signalling anything', async () => {
        const harness = quitHarness([GUI]);
        await quitRunningCaxri(harness.operations);
        expect(harness.quitApplication).toHaveBeenCalledOnce();
        expect(harness.signalled).toEqual([]);
    });

    it('escalates to a signal for the Host that outlives the windowed application', async () => {
        const harness = quitHarness([GUI, HOST]);
        await quitRunningCaxri(harness.operations);
        expect(harness.quitApplication).toHaveBeenCalledOnce();
        expect(harness.signalled).toEqual([HOST.pid]);
    });

    it('reports the surviving process ids instead of replacing a live bundle', async () => {
        const harness = quitHarness([HOST], [HOST.pid]);
        await expect(quitRunningCaxri(harness.operations)).rejects.toThrow(
            `Caxri is still running (PIDs ${HOST.pid})`,
        );
    });

    it('does nothing when the installed bundle is not running', async () => {
        const harness = quitHarness([]);
        await quitRunningCaxri(harness.operations);
        expect(harness.quitApplication).not.toHaveBeenCalled();
        expect(harness.signalled).toEqual([]);
    });
});
