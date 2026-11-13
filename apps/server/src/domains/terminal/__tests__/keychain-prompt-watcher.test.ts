import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { SessionKeychainPrompt } from '@caxri/protocol';
import { ProcessTable } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { KeychainPromptWatcher } from '../keychain-prompt-watcher';

function createWatcher({ spawnStream }: { spawnStream?: () => ChildProcess } = {}) {
    const alive = new Set([300, 500]);
    const changes: Array<ReadonlyMap<string, SessionKeychainPrompt>> = [];
    const write = vi.fn();
    let now = 1_000;
    const table = new ProcessTable([
        { pid: 100, parentPid: 1, cpuPercent: 0, rssKb: 0 },
        {
            pid: 300,
            parentPid: 100,
            cpuPercent: 0,
            rssKb: 0,
            command: 'node /home/dev/cli.js list',
        },
        { pid: 500, parentPid: 1, cpuPercent: 0, rssKb: 0, command: 'gh auth status' },
    ]);
    const watcher = new KeychainPromptWatcher({
        homeDirectory: '/home/dev',
        isAlive: (pid) => alive.has(pid),
        logger: { write } as never,
        now: () => now,
        onChange: (prompts) => changes.push(prompts),
        owners: () => new Map([[100, { provider: 'claude', sessionId: 'session-a' }]]),
        sampleProcessTable: () => Promise.resolve(table),
        spawnStream,
    });
    return {
        advance: (ms: number) => (now += ms),
        alive,
        changes,
        watcher,
        write,
    };
}

describe('KeychainPromptWatcher', () => {
    it('attributes a prompt to the Session whose Terminal started the requester, then clears it on the answer', async () => {
        const { changes, watcher, write } = createWatcher();

        await watcher.handle({ kind: 'shown', pid: 300 });
        expect(changes.at(-1)).toEqual(
            new Map([['session-a', { command: 'node ~/cli.js list', pid: 300, since: 1_000 }]]),
        );

        await watcher.handle({ kind: 'resolved', outcome: 'denied', pid: 300 });
        expect(changes.at(-1)).toEqual(new Map());
        expect(write).toHaveBeenCalledWith(
            'info',
            'terminal.keychain_prompt_resolved',
            expect.objectContaining({ fields: { attributed: true, outcome: 'denied' } }),
        );
        watcher.close();
    });

    it('logs an unattributed prompt without publishing a marker', async () => {
        const { changes, watcher, write } = createWatcher();

        await watcher.handle({ kind: 'shown', pid: 500 });
        await watcher.handle({ kind: 'resolved', outcome: 'allowed', pid: 500 });

        expect(changes).toEqual([]);
        expect(write).toHaveBeenCalledWith('info', 'terminal.keychain_prompt_shown', {
            fields: { attributed: false, provider: null },
        });
        watcher.close();
    });

    it('keeps a prompt answered while its attribution was still in flight closed', async () => {
        const { changes, watcher } = createWatcher();

        const shown = watcher.handle({ kind: 'shown', pid: 300 });
        await watcher.handle({ kind: 'resolved', outcome: 'allowed', pid: 300 });
        await shown;

        expect(changes).toEqual([]);
        watcher.close();
    });

    it('drops a prompt whose requester exited without an answer, and one left open too long', async () => {
        const { advance, alive, changes, watcher, write } = createWatcher();
        await watcher.handle({ kind: 'shown', pid: 300 });

        alive.delete(300);
        watcher.sweep();
        expect(changes.at(-1)).toEqual(new Map());
        expect(write).toHaveBeenLastCalledWith(
            'info',
            'terminal.keychain_prompt_resolved',
            expect.objectContaining({ fields: { attributed: true, outcome: 'exited' } }),
        );

        alive.add(300);
        await watcher.handle({ kind: 'shown', pid: 300 });
        advance(10 * 60_000);
        watcher.sweep();
        expect(write).toHaveBeenLastCalledWith(
            'info',
            'terminal.keychain_prompt_resolved',
            expect.objectContaining({ fields: { attributed: true, outcome: 'expired' } }),
        );
        watcher.close();
    });

    it('clears open prompts when the log stream drops, since an answer given meanwhile is never seen', async () => {
        vi.useFakeTimers();
        // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess exposes EventEmitter, which this test seam mirrors.
        const stream = Object.assign(new EventEmitter(), {
            kill: vi.fn(),
            stdout: new PassThrough(),
        });
        const { changes, watcher, write } = createWatcher({
            spawnStream: () => stream as unknown as ChildProcess,
        });
        watcher.start();
        await watcher.handle({ kind: 'shown', pid: 300 });
        expect(changes.at(-1)?.size).toBe(1);

        stream.emit('exit', 1);

        expect(changes.at(-1)).toEqual(new Map());
        expect(write).toHaveBeenCalledWith(
            'info',
            'terminal.keychain_prompt_resolved',
            expect.objectContaining({ fields: { attributed: true, outcome: 'streamLost' } }),
        );
        watcher.close();
        vi.useRealTimers();
    });
});
