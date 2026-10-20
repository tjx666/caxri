import { describe, expect, it } from 'vitest';

import { KeyedSerialQueue } from '../keyed-serial-queue';

describe('KeyedSerialQueue', () => {
    it('runs tasks for one key in order and tasks for different keys concurrently', async () => {
        const queue = new KeyedSerialQueue<string>();
        const events: string[] = [];
        const gate = Promise.withResolvers<void>();
        const first = queue.run('a', async () => {
            events.push('a1:start');
            await gate.promise;
            events.push('a1:end');
        });
        const second = queue.run('a', () => {
            events.push('a2');
        });
        const other = queue.run('b', () => {
            events.push('b');
        });
        await other;
        expect(events).toEqual(['a1:start', 'b']);
        gate.resolve();
        await Promise.all([first, second]);
        expect(events).toEqual(['a1:start', 'b', 'a1:end', 'a2']);
    });

    it('keeps running successors after a failed predecessor and reports the failure to its caller only', async () => {
        const queue = new KeyedSerialQueue<string>();
        const failed = queue.run('a', () => Promise.reject(new Error('boom')));
        const next = queue.run('a', () => 'ok');
        await expect(failed).rejects.toThrow('boom');
        await expect(next).resolves.toBe('ok');
    });

    it('starts synchronously when idle and forgets a drained key', async () => {
        const queue = new KeyedSerialQueue<string>();
        let isStarted = false;
        const run = queue.run('a', () => {
            isStarted = true;
        });
        expect(isStarted).toBe(true);
        await run;
        await expect(queue.settled('a')).resolves.toBeUndefined();
    });

    it('settled waits for queued tasks even when they fail', async () => {
        const queue = new KeyedSerialQueue<string>();
        const gate = Promise.withResolvers<void>();
        let isDone = false;
        const failing = queue.run('a', async () => {
            await gate.promise;
            isDone = true;
            throw new Error('x');
        });
        const settled = queue.settled('a');
        gate.resolve();
        await settled;
        expect(isDone).toBe(true);
        await expect(failing).rejects.toThrow('x');
    });
});
