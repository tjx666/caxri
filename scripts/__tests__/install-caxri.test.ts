import { describe, expect, it, vi } from 'vitest';

import {
    assertDownloadedSize,
    assertReleaseBundleVersion,
    downloadWithRetries,
    findDmgPair,
    hostStopCommand,
    isHeadlessCaxriProcess,
    isInstalledCaxriCommand,
    parseArguments,
    parseHostStopActivePtyCount,
    parseReleaseView,
    quitRunningCaxri,
    releaseVersionFromTag,
    resolveChecksumStep,
    resolveInstalledProfilePath,
    resumableDownloadArguments,
} from '../install-caxri';

const GUI = { command: '/Applications/Caxri.app/Contents/MacOS/Caxri', pid: 100 };
const HELPER = {
    command:
        '/Applications/Caxri.app/Contents/Frameworks/Caxri Helper.app/Contents/MacOS/Caxri Helper --type=utility --user-data-dir=/Users/me/Library/Application Support/@caxri/desktop --shared-files',
    pid: 101,
};
const HOST = {
    command:
        '/Applications/Caxri.app/Contents/Resources/server/runtime/bin/node /Applications/Caxri.app/Contents/Resources/server/bundles/server-core.js',
    pid: 200,
};

interface FakeProcess {
    command: string;
    pid: number;
}

/**
 * Models the installed bundle's live processes so a test states which of them each shutdown mechanism can actually
 * stop. The Apple event reaches only the windowed application; the bundled CLI reaches Host-owned processes; signals
 * reach anything not pinned for that signal. `wait` resolves immediately, so bounded polling costs no real time.
 */
function quitHarness(
    processes: FakeProcess[],
    options: {
        activePtyCount?: number;
        hostStop?: 'fail' | 'stop';
        unstoppableSignals?: NodeJS.Signals[];
    } = {},
) {
    const alive = new Map(processes.map((entry) => [entry.pid, entry]));
    const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const stopHost = vi.fn(() => {
        if (options.hostStop === 'fail')
            return Promise.reject(new Error('Bundled CLI is unavailable'));
        for (const [pid, entry] of alive) {
            if (isHeadlessCaxriProcess(entry.command)) alive.delete(pid);
        }
        return Promise.resolve(options.activePtyCount ?? 1);
    });
    const quitApp = vi.fn(() => {
        for (const [pid, entry] of alive) {
            if (!isHeadlessCaxriProcess(entry.command)) alive.delete(pid);
        }
        return Promise.resolve();
    });
    return {
        quitApplication: quitApp,
        signalled,
        stopHost,
        operations: {
            list: () => Promise.resolve(alive.values().toArray()),
            quitApplication: quitApp,
            signalProcess: (pid: number, signal: NodeJS.Signals) => {
                signalled.push({ pid, signal });
                if (!options.unstoppableSignals?.includes(signal)) alive.delete(pid);
            },
            stopHost,
            wait: async () => {},
        },
    };
}

describe('install-caxri', () => {
    it('parses an optional release tag and rejects unknown arguments', () => {
        expect(parseArguments([])).toEqual({});
        expect(parseArguments(['--tag', 'v0.0.7'])).toEqual({ tag: 'v0.0.7' });
        expect(parseArguments(['--skip-checksum', '--tag', 'v0.0.7'])).toEqual({
            skipChecksum: true,
            tag: 'v0.0.7',
        });
        expect(parseArguments(['--no-sourcemap'])).toEqual({ shouldOmitSourceMaps: true });
        expect(parseArguments(['--detach', '--relaunch'])).toEqual({
            shouldDetach: true,
            shouldRelaunch: true,
        });
        expect(() => parseArguments(['--nope'])).toThrow('Unknown argument');
        expect(() => parseArguments(['--tag'])).toThrow('Unknown argument');
    });

    it('aborts before mounting when the Release provides no checksum', () => {
        // The regression: a DMG without its `.sha256` used to install silently, with no line about the skipped check.
        expect(() =>
            resolveChecksumStep({ dmg: 'Caxri-0.0.7-arm64.dmg' }, { tag: 'v0.0.7' }),
        ).toThrow(
            'v0.0.7 provides no Caxri-0.0.7-arm64.dmg.sha256, so the downloaded DMG cannot be verified; installation aborted.',
        );
        expect(() => resolveChecksumStep({ dmg: 'Caxri-0.0.7-arm64.dmg' }, {})).toThrow(
            'the latest release provides no Caxri-0.0.7-arm64.dmg.sha256',
        );
    });

    it('verifies when the checksum is present and skips loudly only on explicit request', () => {
        expect(
            resolveChecksumStep(
                { checksum: 'Caxri-0.0.7-arm64.dmg.sha256', dmg: 'Caxri-0.0.7-arm64.dmg' },
                {},
            ),
        ).toEqual({ checksum: 'Caxri-0.0.7-arm64.dmg.sha256', kind: 'verify' });
        const skipped = resolveChecksumStep(
            { dmg: 'Caxri-0.0.7-arm64.dmg' },
            { skipChecksum: true },
        );
        expect(skipped.kind).toBe('skip');
        expect(skipped.kind === 'skip' ? skipped.warning : '').toMatch(
            /^WARNING: .*without verifying its integrity/u,
        );
    });

    it('selects the requested flavor and pairs its checksum companion', () => {
        const names = [
            'Caxri-0.0.7-arm64.dmg',
            'Caxri-0.0.7-arm64.dmg.sha256',
            'Caxri-0.0.7-arm64-nosourcemap.dmg',
            'Caxri-0.0.7-arm64-nosourcemap.dmg.sha256',
        ];
        expect(findDmgPair(names, 'v0.0.7')).toEqual({
            checksum: 'Caxri-0.0.7-arm64.dmg.sha256',
            dmg: 'Caxri-0.0.7-arm64.dmg',
        });
        expect(findDmgPair(names, 'v0.0.7', true)).toEqual({
            checksum: 'Caxri-0.0.7-arm64-nosourcemap.dmg.sha256',
            dmg: 'Caxri-0.0.7-arm64-nosourcemap.dmg',
        });
        expect(findDmgPair(['Caxri-0.0.7-arm64.dmg'], 'v0.0.7')).toEqual({
            checksum: undefined,
            dmg: 'Caxri-0.0.7-arm64.dmg',
        });
    });

    it('fails closed when the exact Release version is absent or duplicated', () => {
        expect(() => findDmgPair(['README.md'], 'v0.0.7')).toThrow(
            'Expected exactly one Caxri-0.0.7-arm64.dmg asset for v0.0.7, found 0.',
        );
        expect(() =>
            findDmgPair(['Caxri-0.0.7-arm64.dmg', 'Caxri-0.0.7-arm64.dmg'], 'v0.0.7'),
        ).toThrow('Expected exactly one Caxri-0.0.7-arm64.dmg asset for v0.0.7, found 2.');
        expect(() =>
            findDmgPair(['Caxri-9.9.9-arm64.dmg', 'Caxri-9.9.9-arm64.dmg.sha256'], 'v0.0.7'),
        ).toThrow('Expected exactly one Caxri-0.0.7-arm64.dmg asset for v0.0.7, found 0.');
    });

    it('binds canonical Release tags to both the asset and bundle version', () => {
        expect(releaseVersionFromTag('v0.0.7')).toBe('0.0.7');
        expect(releaseVersionFromTag('v1.2.3-beta.1')).toBe('1.2.3-beta.1');
        expect(releaseVersionFromTag('v1.2.3+build.1')).toBe('1.2.3+build.1');
        expect(() => releaseVersionFromTag('0.0.7')).toThrow('canonical vX.Y.Z Release tag');
        expect(() => releaseVersionFromTag('vlatest')).toThrow('canonical vX.Y.Z Release tag');
        expect(assertReleaseBundleVersion('v0.0.7', '0.0.7\n')).toBe('0.0.7');
        expect(() => assertReleaseBundleVersion('v0.0.7', '9.9.9')).toThrow(
            'v0.0.7 must contain Caxri 0.0.7, but the downloaded bundle reports 9.9.9.',
        );
    });

    it('separates the detached Server from the windowed application', () => {
        expect(isHeadlessCaxriProcess(HOST.command)).toBe(true);
        expect(isHeadlessCaxriProcess(GUI.command)).toBe(false);
        expect(isHeadlessCaxriProcess(`${GUI.command} --enable-features=Foo`)).toBe(false);
    });

    it('matches only executables loaded from the exact installed bundle', () => {
        expect(isInstalledCaxriCommand(GUI.command)).toBe(true);
        expect(isInstalledCaxriCommand(HELPER.command)).toBe(true);
        expect(isInstalledCaxriCommand('/Applications/Caxri.app.old/Contents/MacOS/Caxri')).toBe(
            false,
        );
    });

    it('resolves the packaged profile from Electron helpers before its safe default', () => {
        expect(resolveInstalledProfilePath([HELPER], undefined, '/Users/example')).toBe(
            '/Users/me/Library/Application Support/@caxri/desktop',
        );
        expect(resolveInstalledProfilePath([], undefined, '/Users/example')).toBe(
            '/Users/example/Library/Application Support/@caxri/desktop',
        );
        expect(resolveInstalledProfilePath([], '/profiles/selected', '/Users/example')).toBe(
            '/profiles/selected',
        );
    });

    it('builds and parses the installed CLI Host-stop contract', () => {
        expect(hostStopCommand('/profiles/selected')).toEqual({
            arguments: [
                'host',
                'stop',
                '--force',
                '--profile',
                '/profiles/selected',
                '--yes',
                '--json',
                '--timeout',
                '30000',
            ],
            command: '/Applications/Caxri.app/Contents/Resources/bin/caxri',
        });
        expect(parseHostStopActivePtyCount('{"stopping":true,"activePtyCount":7}\n')).toBe(7);
        expect(parseHostStopActivePtyCount('{"stopping":true}')).toBeUndefined();
    });

    it('signals a Server that no Apple event can reach', async () => {
        // The regression: once the last window closes, the bundle still runs its detached background
        // processes. Waiting out an Apple event nothing receives failed every installer run.
        const harness = quitHarness([HOST], { hostStop: 'fail' });
        await quitRunningCaxri(harness.operations);
        expect(harness.quitApplication).not.toHaveBeenCalled();
        expect(harness.signalled).toEqual([{ pid: HOST.pid, signal: 'SIGTERM' }]);
    });

    it('lets the windowed application quit on its own before signalling anything', async () => {
        const harness = quitHarness([GUI]);
        await quitRunningCaxri(harness.operations);
        expect(harness.quitApplication).toHaveBeenCalledOnce();
        expect(harness.signalled).toEqual([]);
    });

    it('stops the Host before force-terminating Desktop processes that could restart it', async () => {
        const harness = quitHarness([GUI, HELPER, HOST]);
        await quitRunningCaxri(harness.operations);
        expect(harness.stopHost).toHaveBeenCalledOnce();
        expect(harness.quitApplication).not.toHaveBeenCalled();
        expect(harness.signalled).toEqual([
            { pid: GUI.pid, signal: 'SIGKILL' },
            { pid: HELPER.pid, signal: 'SIGKILL' },
        ]);
    });

    it('lets Desktop persist its state when the stopped Host had no active tasks', async () => {
        const harness = quitHarness([GUI, HOST], { activePtyCount: 0 });
        await quitRunningCaxri(harness.operations);
        expect(harness.stopHost).toHaveBeenCalledOnce();
        expect(harness.quitApplication).toHaveBeenCalledOnce();
        expect(harness.signalled).toEqual([]);
    });

    it('escalates from SIGTERM to SIGKILL when an old Host cannot stop cleanly', async () => {
        const harness = quitHarness([HOST], {
            hostStop: 'fail',
            unstoppableSignals: ['SIGTERM'],
        });
        await quitRunningCaxri(harness.operations);
        expect(harness.signalled).toEqual([
            { pid: HOST.pid, signal: 'SIGTERM' },
            { pid: HOST.pid, signal: 'SIGKILL' },
        ]);
    });

    it('reports the surviving process ids instead of replacing a live bundle', async () => {
        const harness = quitHarness([HOST], {
            hostStop: 'fail',
            unstoppableSignals: ['SIGTERM', 'SIGKILL'],
        });
        await expect(quitRunningCaxri(harness.operations)).rejects.toThrow(
            `Caxri is still running after forced shutdown (PIDs ${HOST.pid})`,
        );
    });

    it('does nothing when the installed bundle is not running', async () => {
        const harness = quitHarness([]);
        await quitRunningCaxri(harness.operations);
        expect(harness.quitApplication).not.toHaveBeenCalled();
        expect(harness.signalled).toEqual([]);
    });
});

describe('release download', () => {
    const DMG_URL =
        'https://github.com/owner/example/releases/download/v0.0.7/Caxri-0.0.7-arm64.dmg';

    it('reads the tag and the downloadable assets from gh release view', () => {
        expect(
            parseReleaseView(
                JSON.stringify({
                    assets: [
                        { name: 'Caxri-0.0.7-arm64.dmg', size: 42, url: DMG_URL },
                        { name: 'broken' },
                    ],
                    tagName: 'v0.0.7',
                }),
            ),
        ).toEqual({
            assets: [{ name: 'Caxri-0.0.7-arm64.dmg', size: 42, url: DMG_URL }],
            tag: 'v0.0.7',
        });
        expect(() => parseReleaseView('{}')).toThrow('no tagName');
    });

    it('resumes into the partial file and aborts stalled transfers', () => {
        const arguments_ = resumableDownloadArguments(DMG_URL, '/tmp/install/Caxri.dmg');
        expect(arguments_.join(' ')).toContain('--continue-at -');
        expect(arguments_.join(' ')).toContain('--speed-limit 1024 --speed-time 60');
        expect(arguments_).toContain('--fail');
        expect(arguments_.slice(-3)).toEqual(['--output', '/tmp/install/Caxri.dmg', DMG_URL]);
    });

    it('retries an interrupted download until it completes', async () => {
        const download = vi
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(new Error('unexpected EOF'))
            .mockRejectedValueOnce(new Error('unexpected EOF'))
            .mockResolvedValueOnce();
        const onRetry = vi.fn<(failedAttempt: number, error: unknown) => void>();
        await downloadWithRetries({ download, onRetry, wait: () => Promise.resolve() });
        expect(download).toHaveBeenCalledTimes(3);
        expect(onRetry.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2]);
    });

    it('rethrows the last failure once the attempts are spent', async () => {
        const download = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('reset'));
        await expect(
            downloadWithRetries({ download, onRetry: vi.fn(), wait: () => Promise.resolve() }, 3),
        ).rejects.toThrow('reset');
        expect(download).toHaveBeenCalledTimes(3);
    });

    it('rejects a download whose size differs from the Release record', () => {
        const asset = { name: 'Caxri-0.0.7-arm64.dmg', size: 42 };
        expect(() => assertDownloadedSize(asset, 42)).not.toThrow();
        expect(() => assertDownloadedSize(asset, 41)).toThrow('downloaded 41 bytes');
    });
});
