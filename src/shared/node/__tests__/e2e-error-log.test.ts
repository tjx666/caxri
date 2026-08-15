import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseE2ELogErrors, readE2ELogSnapshots } from '../e2e-error-log';
import { assertE2EErrorPolicy } from '../e2e-error-policy';

const record = (
    process: 'host' | 'main' | 'runtime',
    level: 'error' | 'info',
    event: string,
    code?: string,
) => `${JSON.stringify({ process, level, event, fields: code ? { code } : undefined })}\n`;

describe('E2E structured log collection', () => {
    it('collects rotated and active Main and Runtime logs in chronological order', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-e2e-error-log-'));
        const logDirectory = join(userDataDirectory, 'logs');
        await mkdir(logDirectory);
        await Promise.all([
            writeFile(
                join(logDirectory, 'main.jsonl.1'),
                record('main', 'error', 'main.early_failure', 'MAIN_EARLY_FAILURE'),
            ),
            writeFile(join(logDirectory, 'main.jsonl'), record('main', 'info', 'main.ready')),
            writeFile(join(logDirectory, 'host.jsonl'), record('host', 'info', 'host.ready')),
            writeFile(
                join(logDirectory, 'runtime.jsonl'),
                record('runtime', 'error', 'runtime.late_failure', 'RUNTIME_LATE_FAILURE'),
            ),
        ]);

        try {
            const snapshots = readE2ELogSnapshots(userDataDirectory);

            expect(snapshots.map(({ path }) => path.slice(logDirectory.length + 1))).toEqual([
                'host.jsonl',
                'main.jsonl.1',
                'main.jsonl',
                'runtime.jsonl',
            ]);
            const errors = parseE2ELogErrors(snapshots);
            expect(errors).toEqual([
                {
                    source: 'main',
                    event: 'main.early_failure',
                    code: 'MAIN_EARLY_FAILURE',
                },
                {
                    source: 'runtime',
                    event: 'runtime.late_failure',
                    code: 'RUNTIME_LATE_FAILURE',
                },
            ]);
            expect(() => assertE2EErrorPolicy(errors, [])).toThrow(
                'Unexpected E2E errors: main/main.early_failure/MAIN_EARLY_FAILURE x1, runtime/runtime.late_failure/RUNTIME_LATE_FAILURE x1',
            );
        } finally {
            await rm(userDataDirectory, { recursive: true, force: true });
        }
    });

    it('classifies malformed Runtime JSONL as an exact Runtime gate error', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-e2e-error-log-'));
        const logDirectory = join(userDataDirectory, 'logs');
        await mkdir(logDirectory);
        await writeFile(join(logDirectory, 'runtime.jsonl'), '{not-json}\n');

        try {
            expect(parseE2ELogErrors(readE2ELogSnapshots(userDataDirectory))).toEqual([
                { source: 'runtime', event: 'e2e.log_invalid', code: 'INVALID_JSONL' },
            ]);
        } finally {
            await rm(userDataDirectory, { recursive: true, force: true });
        }
    });
});
