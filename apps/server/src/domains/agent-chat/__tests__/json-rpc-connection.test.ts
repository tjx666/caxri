import { Buffer } from 'node:buffer';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { ChatProcessEnd } from '../chat-provider';
import { JsonRpcConnection } from '../json-rpc-connection';

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

function connect(child: ChildProcessWithoutNullStreams, isAcp?: boolean) {
    const notifications: Array<[string, Record<string, unknown>]> = [];
    const ends: ChatProcessEnd[] = [];
    const connection = new JsonRpcConnection({
        label: 'Codex app-server',
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
        jsonrpc: isAcp,
    });
    return { connection, notifications, ends };
}

describe('JsonRpcConnection framing', () => {
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

    it('reports a response before the frames that follow it in the same read', async () => {
        const child = fakeChild();
        const { connection, notifications } = connect(child);
        let seenAtResponse: number | undefined;
        const response = connection.request('goal/set', {}, undefined, () => {
            seenAtResponse = notifications.length;
        });
        child.stdout.emit(
            'data',
            Buffer.from('{"method":"before"}\n{"id":1,"result":{}}\n{"method":"after"}\n'),
        );
        await response;
        expect(seenAtResponse).toBe(1);
        expect(notifications.map(([method]) => method)).toEqual(['before', 'after']);
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

    it('tags outgoing frames for ACP and ignores responses to requests it never sent', async () => {
        const stdin = new PassThrough();
        const child = fakeChild(stdin);
        const { connection, ends } = connect(child, true);
        const written: string[] = [];
        stdin.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
        const response = connection.request('initialize', { protocolVersion: 1 });
        await vi.waitFor(() => expect(written).toHaveLength(1));
        expect(JSON.parse(written[0] ?? '')).toEqual({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: 1 },
        });
        child.stdout.emit(
            'data',
            Buffer.from('{"jsonrpc":"2.0","id":"skills-reload","result":{}}\n'),
        );
        child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n'));
        await expect(response).resolves.toEqual({ ok: true });
        expect(connection.counters.droppedFrames).toBe(0);
        expect(ends).toEqual([]);
    });
});
