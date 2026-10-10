import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StructuredLogger } from '@caxri/system';
import { AsyncSemaphore, execFileAsync, logEventCatalog } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runGitCommand } from '../command';
import { withGitRequestSignal } from '../request-signal';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pending = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pending.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Captures the raw fields handed to the sink. Asserting at the call site, before any sink-side redaction, is what
 * proves the event itself never carries the content.
 */
function recordingLogger(): {
    logger: StructuredLogger;
    failures: () => unknown[];
    failureLevels: () => string[];
} {
    const write = vi.fn<StructuredLogger['write']>();
    const failureCalls = () =>
        write.mock.calls.filter(([, event]) => event === logEventCatalog.git.commandFailed);
    return {
        logger: { write } as unknown as StructuredLogger,
        failures: () => failureCalls().map((call) => call[2]),
        failureLevels: () => failureCalls().map(([level]) => level),
    };
}

/**
 * Node's promisified `execFile` rejects with `Command failed: git <full argv>\n<stderr>`, so logging that message put
 * refs, `rev:path` specs, and Git's own stderr into `git.command_failed`, the event whose contract is that it never
 * carries a path or ref.
 */
describe('git.command_failed', () => {
    it('records the closed reason and exit status without the argv, path, ref, or stderr', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-failure-log-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
        const reference = 'refs/heads/caxri-private-branch-name';
        const path = 'caxri-private-directory/caxri-private-file.txt';
        const { logger, failures } = recordingLogger();

        await expect(
            runGitCommand(new AsyncSemaphore(1), logger, directory, [
                'show',
                `${reference}:${path}`,
            ]),
        ).rejects.toMatchObject({ code: 'GIT' });

        expect(failures()).toHaveLength(1);
        const [record] = failures();
        expect(record).toMatchObject({
            fields: {
                operation: 'show',
                reason: 'exit',
                exitCode: 128,
                signal: null,
                errorCode: null,
            },
        });
        const serialized = JSON.stringify(record);
        expect(serialized).not.toContain('caxri-private-branch-name');
        expect(serialized).not.toContain('caxri-private-directory');
        expect(serialized).not.toContain('caxri-private-file');
        expect(serialized).not.toContain(directory);
        expect(serialized).not.toContain('fatal:');
        expect(serialized).not.toContain('Command failed');
    });

    it('records the terminating signal of a timed-out command instead of its message', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-timeout-log-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
        const { logger, failures } = recordingLogger();

        // `cat-file --batch` waits on stdin, which stays open without `input`, so only the timeout ends it.
        await expect(
            runGitCommand(new AsyncSemaphore(1), logger, directory, ['cat-file', '--batch'], {
                timeoutMs: 100,
            }),
        ).rejects.toMatchObject({ code: 'GIT', message: 'The Git operation timed out.' });

        expect(failures()).toHaveLength(1);
        expect(failures()[0]).toMatchObject({
            fields: {
                operation: 'cat-file',
                reason: 'timeout',
                exitCode: null,
                signal: 'SIGTERM',
                errorCode: null,
            },
        });
        expect(JSON.stringify(failures())).not.toContain('Command failed');
    });

    /**
     * Source Control aborts a history-detail request as soon as the user navigates on. Node rejects that child with an
     * `AbortError`, which used to read as Git's own non-zero exit: a warn per keystroke and a `GIT` error for a request
     * its caller had already abandoned.
     */
    it.each([false, true])(
        'records an aborted command as cancelled at debug and rejects with CANCELLED (allowFailure %s)',
        async (allowFailure) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-git-cancel-log-'));
            temporaryDirectories.push(directory);
            await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
            const { logger, failures, failureLevels } = recordingLogger();
            const request = new AbortController();

            // `cat-file --batch` waits on stdin, so only the abort ends it.
            const running = withGitRequestSignal(request.signal, () =>
                runGitCommand(new AsyncSemaphore(1), logger, directory, ['cat-file', '--batch'], {
                    allowFailure,
                }),
            );
            setTimeout(() => request.abort(), 50);

            await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
            expect(failureLevels()).toEqual(['debug']);
            expect(failures()[0]).toMatchObject({
                fields: { operation: 'cat-file', reason: 'cancelled', errorCode: 'ABORT_ERR' },
            });
        },
    );
});
