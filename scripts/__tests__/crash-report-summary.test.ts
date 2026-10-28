import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { printNodeCrashReports, summarizeCrashReport } from '../crash-report-summary';

const header = JSON.stringify({ app_name: 'node', bug_type: '309' });
const body = {
    exception: { signal: 'SIGSEGV', type: 'EXC_BAD_ACCESS' },
    faultingThread: 1,
    procName: 'node',
    threads: [
        { frames: [{ imageIndex: 0, imageOffset: 1 }] },
        {
            frames: [
                { imageIndex: 1, imageOffset: 4096, symbol: 'sqlite3VdbeExec' },
                { imageIndex: 0, imageOffset: 8192 },
            ],
        },
    ],
    usedImages: [
        { name: 'node', path: '/private/path/node' },
        { name: 'better_sqlite3.node', path: '/private/path/better_sqlite3.node' },
    ],
};

describe('crash report summary', () => {
    it('keeps the faulting thread by image name and symbol, without paths', () => {
        const summary = summarizeCrashReport(`${header}\n${JSON.stringify(body)}`);
        expect(summary).toEqual([
            'node: EXC_BAD_ACCESS (SIGSEGV), thread 1',
            '  0 better_sqlite3.node sqlite3VdbeExec',
            '  1 node +8192',
        ]);
        expect(summary?.join('\n')).not.toContain('/private');
    });

    it('ignores text that is not a crash report', () => {
        expect(summarizeCrashReport('not a report')).toBeUndefined();
        expect(summarizeCrashReport(`${header}\n{`)).toBeUndefined();
        expect(
            summarizeCrashReport(`${header}\n${JSON.stringify({ procName: 'node' })}`),
        ).toBeUndefined();
    });

    describe('printing reports from a directory', () => {
        let directory: string | undefined;

        afterEach(async () => {
            vi.restoreAllMocks();
            if (directory) await rm(directory, { force: true, recursive: true });
        });

        it('prints only node reports written since the run started', async () => {
            directory = await mkdtemp(join(tmpdir(), 'crash-reports-'));
            const report = `${header}\n${JSON.stringify(body)}`;
            await writeFile(join(directory, 'node-2026-10-27-120000.ips'), report);
            await writeFile(join(directory, 'node-2026-10-20-120000.ips'), report);
            await utimes(join(directory, 'node-2026-10-20-120000.ips'), 0, 0);
            await writeFile(join(directory, 'Electron-2026-10-27-120000.ips'), report);
            const log = vi.spyOn(console, 'log').mockImplementation(() => {});

            await printNodeCrashReports(1000, directory);

            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0]?.[0]).toMatch(/^Native crash report:\nnode: EXC_BAD_ACCESS/u);
        });

        it('stays quiet when the report directory is missing', async () => {
            const log = vi.spyOn(console, 'log').mockImplementation(() => {});
            await printNodeCrashReports(0, join(tmpdir(), 'missing-crash-reports-directory'));
            expect(log).not.toHaveBeenCalled();
        });
    });
});
