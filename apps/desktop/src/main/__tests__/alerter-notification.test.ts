import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
    buildAlerterArguments,
    createAlerterNotificationDriver,
    isAlerterClick,
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
