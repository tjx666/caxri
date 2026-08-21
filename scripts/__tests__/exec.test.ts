import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { waitForChildExit } from '../exec';

function createChild(): ChildProcess {
    // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess exposes Node EventEmitter events.
    return new EventEmitter() as ChildProcess;
}

describe('child process exit handling', () => {
    it('returns the process exit code', async () => {
        const child = createChild();
        const result = waitForChildExit(child);

        child.emit('exit', 7, null);

        await expect(result).resolves.toBe(7);
    });

    it('maps signal termination to a non-zero exit code', async () => {
        const child = createChild();
        const result = waitForChildExit(child);

        child.emit('exit', null, 'SIGTERM');

        await expect(result).resolves.toBe(1);
    });

    it('rejects process launch errors', async () => {
        const child = createChild();
        const result = waitForChildExit(child);

        child.emit('error', new Error('spawn failed'));

        await expect(result).rejects.toThrow('spawn failed');
    });

    it('can preserve callers that wait for closed stdio', async () => {
        const child = createChild();
        const result = waitForChildExit(child, { event: 'close' });

        child.emit('exit', 0, null);
        child.emit('close', 4, null);

        await expect(result).resolves.toBe(4);
    });

    it('preserves a caller-specific fallback for a missing code and signal', async () => {
        const child = createChild();
        const result = waitForChildExit(child, { nullExitCode: 9 });

        child.emit('exit', null, null);

        await expect(result).resolves.toBe(9);
    });
});
