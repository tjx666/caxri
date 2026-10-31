import { ChildProcess } from 'node:child_process';
import process from 'node:process';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
    ALERTER_NEGATIVE_PROBE_TTL_MS,
    alerterCandidates,
    buildAlerterArguments,
    createAlerterNotificationDriver,
    isAlerterClick,
    shouldReprobeAlerter,
} from '../alerter-notification';

const notification = {
    body: 'Claude Code is waiting for your input.',
    groupId: 'caxri-agent-sessions',
    id: 'caxri-agent-session-session-1',
    title: 'Background session',
};

function fakeProcess(): {
    child: ChildProcess;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
} {
    const child = new ChildProcess();
    const kill = vi.fn(() => true);
    const unref = vi.fn();
    Object.defineProperty(child, 'stdout', { value: new PassThrough() });
    child.kill = kill;
    child.unref = unref;
    return { child, kill, unref };
}

describe('alerter notification adapter', () => {
    it('uses the notification id as the replacement group', () => {
        expect(buildAlerterArguments(notification)).toEqual([
            '--json',
            '--title',
            'Background session',
            '--message',
            'Claude Code is waiting for your input.',
            '--sound',
            'default',
            '--timeout',
            '30',
            '--group',
            'caxri-agent-session-session-1',
        ]);
        expect(buildAlerterArguments({ ...notification, subtitle: 'caxri' }).slice(1, 5)).toEqual([
            '--title',
            'Background session',
            '--subtitle',
            'caxri',
        ]);
        expect(buildAlerterArguments(notification, '/app/Resources/icon.icns').slice(0, 3)).toEqual(
            ['--json', '--app-icon', '/app/Resources/icon.icns'],
        );
    });

    it('routes only a content click back into Caxri', () => {
        expect(isAlerterClick('{"activationType":"contentsClicked"}')).toBe(true);
        expect(isAlerterClick('{"activationType":"timeout"}')).toBe(false);
        expect(isAlerterClick('invalid')).toBe(false);
    });

    it('routes a helper click and removes the delivered notification on close', async () => {
        const processes: Array<ReturnType<typeof fakeProcess>> = [];
        const spawnProcess = vi.fn<
            (executable: string, arguments_: readonly string[]) => ChildProcess
        >(() => {
            const process = fakeProcess();
            processes.push(process);
            return process.child;
        });
        const driver = createAlerterNotificationDriver({
            resolveExecutable: () => Promise.resolve('/signed/alerter'),
            spawnProcess,
        });
        const onClick = vi.fn();
        const onFailure = vi.fn();

        const handle = driver.show(notification, onClick, onFailure);
        await vi.waitFor(() => expect(spawnProcess.mock.calls).toHaveLength(1));
        processes[0]?.child.stdout?.emit('data', '{"activationType":"contentsClicked"}');
        processes[0]?.child.emit('close', 0, null);

        expect(onClick).toHaveBeenCalledOnce();
        expect(onFailure).not.toHaveBeenCalled();

        handle.close();
        expect(processes[0]?.kill).toHaveBeenCalledOnce();
        expect(spawnProcess.mock.calls[1]?.[1]).toEqual([
            '--remove',
            'caxri-agent-session-session-1',
        ]);
        expect(processes[1]?.unref).toHaveBeenCalledOnce();
    });
});

describe('alerter lookup caching', () => {
    it('decides re-probing from the cached answer, its age, and force', () => {
        const now = 1_000_000;
        expect(shouldReprobeAlerter(undefined, now, false)).toBe(true);
        expect(shouldReprobeAlerter({ checkedAt: 0, found: true }, now, false)).toBe(false);
        expect(shouldReprobeAlerter({ checkedAt: now - 1, found: false }, now, false)).toBe(false);
        expect(
            shouldReprobeAlerter(
                { checkedAt: now - ALERTER_NEGATIVE_PROBE_TTL_MS, found: false },
                now,
                false,
            ),
        ).toBe(true);
        expect(shouldReprobeAlerter({ checkedAt: now, found: true }, now, true)).toBe(true);
    });

    it('looks again after the negative answer expires, on demand, and never for a found helper', async () => {
        let clock = 0;
        const installation: { path?: string } = {};
        const resolveExecutable = vi.fn(() => Promise.resolve(installation.path));
        const driver = createAlerterNotificationDriver({ now: () => clock, resolveExecutable });

        await expect(driver.isAvailable()).resolves.toBe(false);
        installation.path = '/opt/homebrew/bin/alerter';
        clock = ALERTER_NEGATIVE_PROBE_TTL_MS - 1;
        await expect(driver.isAvailable()).resolves.toBe(false);
        expect(resolveExecutable).toHaveBeenCalledOnce();

        await expect(driver.isAvailable({ isForced: true })).resolves.toBe(true);
        expect(resolveExecutable).toHaveBeenCalledTimes(2);

        clock += 10 * ALERTER_NEGATIVE_PROBE_TTL_MS;
        await expect(driver.isAvailable()).resolves.toBe(true);
        expect(resolveExecutable).toHaveBeenCalledTimes(2);
    });

    it('picks up a helper installed after a negative answer once the TTL passes', async () => {
        let clock = 0;
        const installation: { path?: string } = {};
        const driver = createAlerterNotificationDriver({
            now: () => clock,
            resolveExecutable: () => Promise.resolve(installation.path),
        });
        await expect(driver.isAvailable()).resolves.toBe(false);

        installation.path = '/usr/local/bin/alerter';
        clock = ALERTER_NEGATIVE_PROBE_TTL_MS;

        // The expired miss is re-probed in the background: this call answers with the current state without waiting.
        await expect(driver.isAvailable()).resolves.toBe(false);
        await vi.waitFor(async () => {
            await expect(driver.isAvailable()).resolves.toBe(true);
        });
    });

    it('does not keep a rejected lookup cached', async () => {
        const resolveExecutable = vi
            .fn<() => Promise<string | undefined>>()
            .mockRejectedValueOnce(new Error('lookup failed'))
            .mockResolvedValue('/opt/homebrew/bin/alerter');
        const driver = createAlerterNotificationDriver({ resolveExecutable });

        await expect(driver.isAvailable()).rejects.toThrow('lookup failed');
        await expect(driver.isAvailable()).resolves.toBe(true);
    });

    it('shares one probe between concurrent callers', async () => {
        const resolveExecutable = vi.fn(() => Promise.resolve(undefined));
        const driver = createAlerterNotificationDriver({ resolveExecutable });

        await Promise.all([driver.isAvailable(), driver.isAvailable()]);

        expect(resolveExecutable).toHaveBeenCalledOnce();
    });

    it('falls back to the login shell PATH when the fixed locations miss', async () => {
        const driver = createAlerterNotificationDriver({
            candidates: ['/nonexistent/caxri-alerter'],
            lookupOnLoginShellPath: () => Promise.resolve(process.execPath),
        });

        await expect(driver.isAvailable()).resolves.toBe(true);
    });

    it('tries the helper bundled with a packaged build before Homebrew, and only Homebrew in development', () => {
        const resourcesPath = '/Applications/Caxri.app/Contents/Resources';
        expect(alerterCandidates({ isPackaged: true, resourcesPath })).toEqual([
            `${resourcesPath}/bin/alerter`,
            '/opt/homebrew/bin/alerter',
            '/usr/local/bin/alerter',
        ]);
        expect(alerterCandidates({ isPackaged: false, resourcesPath })).toEqual([
            '/opt/homebrew/bin/alerter',
            '/usr/local/bin/alerter',
        ]);
    });
});
