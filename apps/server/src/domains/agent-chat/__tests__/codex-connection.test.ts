import { Buffer } from 'node:buffer';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { ChatProcessEnd } from '../chat-provider';
import { CodexConnection } from '../codex-connection';

/**
 * A child process whose stdout the test writes chunk by chunk and whose stdin can stop draining.
 */
function fakeChild(stdin: Writable = new PassThrough()) {
    // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess exposes EventEmitter, which this test seam mirrors.
    const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: undefined,
        exitCode: null,
        signalCode: null,
        kill: () => true,
    });
    return child as unknown as ChildProcessWithoutNullStreams & { stdout: PassThrough };
}

function connect(child: ChildProcessWithoutNullStreams) {
    const notifications: Array<[string, Record<string, unknown>]> = [];
    const ends: ChatProcessEnd[] = [];
    const connection = new CodexConnection({
        executable: 'codex',
        args: ['app-server'],
        cwd: '/',
        environment: {},
        handlers: {
            onNotification: (method, parameters) => notifications.push([method, parameters]),
            onServerRequest: vi.fn(),
            onEnd: (end) => ends.push(end),
        },
        spawnProcess: () => child,
    });
    return { connection, notifications, ends };
}

describe('CodexConnection framing', () => {
    it('reassembles frames split mid-character and reads several frames from one chunk', () => {
        const child = fakeChild();
        const { notifications } = connect(child);
        const frame = Buffer.from(
            `${JSON.stringify({ method: 'note', params: { text: '你好' } })}\n`,
        );
        const split = frame.indexOf(Buffer.from('你')) + 1;
        child.stdout.emit('data', frame.subarray(0, split));
        child.stdout.emit('data', frame.subarray(split));
        child.stdout.emit('data', Buffer.from('{"method":"a"}\n{"method":"b"}\n{"meth'));
        child.stdout.emit('data', Buffer.from('od":"c"}\n'));
        expect(notifications.map(([method]) => method)).toEqual(['note', 'a', 'b', 'c']);
        expect(notifications[0]?.[1]).toEqual({ text: '你好' });
    });

    it('rejects an oversized frame before parsing it, even when its final chunk completes it', () => {
        const child = fakeChild();
        const { notifications, ends, connection } = connect(child);
        const prefix = '{"method":"big","params":{"t":"';
        // Two bytes under the bound until the closing `"}}` arrives.
        const body = 'x'.repeat(32 * 1024 * 1024 - prefix.length - 2);
        child.stdout.emit('data', Buffer.from(`${prefix}${body}`));
        expect(ends).toEqual([]);
        child.stdout.emit('data', Buffer.from('"}}\n'));
        expect(ends).toEqual([{ reason: 'frameTooLarge' }]);
        expect(notifications).toEqual([]);
        expect(connection.isOpen).toBe(false);
    });

    it('fails the connection once the provider stops reading its input', () => {
        const stalled = new Writable({ highWaterMark: 1, write: () => {} });
        const child = fakeChild(stalled);
        const { connection, ends } = connect(child);
        const text = 'y'.repeat(1024 * 1024);
        for (let index = 0; index < 10 && connection.isOpen; index += 1)
            connection.notify('turn/steer', { text });
        expect(ends).toEqual([{ reason: 'writeFailed' }]);
    });
});
