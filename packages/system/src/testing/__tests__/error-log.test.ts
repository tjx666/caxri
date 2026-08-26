import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseE2ELogErrors, readE2ELogSnapshots } from '../error-log';
import { assertE2EErrorPolicy } from '../error-policy';

const record = (
    process: 'desktop' | 'extension-host' | 'server-core' | 'terminal-host',
    level: 'error' | 'info',
    event: string,
    code?: string,
) => `${JSON.stringify({ process, level, event, fields: code ? { code } : undefined })}\n`;

describe('E2E structured log collection', () => {
    it('collects rotated and active Desktop and Server Core logs in chronological order', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-e2e-error-log-'));
        const logDirectory = join(userDataDirectory, 'logs');
        await mkdir(logDirectory);
        await Promise.all([
            writeFile(
                join(logDirectory, 'desktop.jsonl.1'),
                record('desktop', 'error', 'desktop.early_failure', 'DESKTOP_EARLY_FAILURE'),
            ),
            writeFile(
                join(logDirectory, 'desktop.jsonl'),
                record('desktop', 'info', 'desktop.ready'),
            ),
            writeFile(
                join(logDirectory, 'server-core.jsonl'),
                record(
                    'server-core',
                    'error',
                    'server_core.late_failure',
                    'SERVER_CORE_LATE_FAILURE',
                ),
            ),
        ]);

        try {
            const snapshots = readE2ELogSnapshots(userDataDirectory);

            expect(snapshots.map(({ path }) => path.slice(logDirectory.length + 1))).toEqual([
                'desktop.jsonl.1',
                'desktop.jsonl',
                'server-core.jsonl',
            ]);
            const errors = parseE2ELogErrors(snapshots);
            expect(errors).toEqual([
                {
                    source: 'desktop',
                    event: 'desktop.early_failure',
                    code: 'DESKTOP_EARLY_FAILURE',
                },
                {
                    source: 'server-core',
                    event: 'server_core.late_failure',
                    code: 'SERVER_CORE_LATE_FAILURE',
                },
            ]);
            expect(() => assertE2EErrorPolicy(errors, [])).toThrow(
                'Unexpected E2E errors: desktop/desktop.early_failure/DESKTOP_EARLY_FAILURE x1, server-core/server_core.late_failure/SERVER_CORE_LATE_FAILURE x1',
            );
        } finally {
            await rm(userDataDirectory, { recursive: true, force: true });
        }
    });

    it('classifies malformed Server Core JSONL as an exact Server Core gate error', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-e2e-error-log-'));
        const logDirectory = join(userDataDirectory, 'logs');
        await mkdir(logDirectory);
        await writeFile(join(logDirectory, 'server-core.jsonl'), '{not-json}\n');

        try {
            expect(parseE2ELogErrors(readE2ELogSnapshots(userDataDirectory))).toEqual([
                { source: 'server-core', event: 'e2e.log_invalid', code: 'INVALID_JSONL' },
            ]);
        } finally {
            await rm(userDataDirectory, { recursive: true, force: true });
        }
    });
});
