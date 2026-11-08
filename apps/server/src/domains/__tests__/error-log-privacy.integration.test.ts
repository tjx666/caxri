import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { errorLogFields, logEventCatalog, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { execFileInProcessGroup } from '../process-group';

const privateStrings = ['owner/example', 'feature/example', '/opt/example'];
const directories: string[] = [];

afterEach(async () => {
    const pending = [...directories];
    directories.length = 0;
    await Promise.all(pending.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Concatenates every JSONL file in the log directory, which is exactly what the diagnostics bundle archives under
 * `diagnostics/logs/` (`DiagnosticsService.readLogs` copies each file verbatim).
 */
async function readBundledLogs(directory: string): Promise<string> {
    const names = await readdir(directory);
    const contents = await Promise.all(
        names.map((name) => readFile(join(directory, name), 'utf8')),
    );
    return contents.join('\n');
}

/**
 * Diagnostics bundles copy the logs verbatim and the logger redacts only home paths and credential-shaped tokens, so a
 * failing command whose stderr names a repository slug, a branch, and an absolute path must leave none of them in a
 * record written through the shared error-field policy.
 */
describe('error text in exported logs', () => {
    it('keeps a failed command repository, branch, and path out of the log records', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-error-log-privacy-'));
        directories.push(directory);
        const logger = new StructuredLogger(directory, 'server-core', 'debug');
        let failure: unknown;
        try {
            await execFileInProcessGroup(
                process.execPath,
                [
                    '-e',
                    `process.stderr.write(${JSON.stringify(
                        `fatal: could not read ${privateStrings.join(' ')}`,
                    )}); process.exit(1)`,
                ],
                { env: process.env, maxBuffer: 1_000_000, timeout: 10_000 },
            );
        } catch (error) {
            failure = error;
        }
        // The failure itself does carry the text, so the assertions below prove the policy and not an empty fixture.
        for (const value of privateStrings) expect((failure as Error).message).toContain(value);

        logger.write('warn', logEventCatalog.sessionPullRequests.refreshFailed, {
            fields: { ...errorLogFields(failure), sessionId: 'session-1' },
        });
        await logger.flush();

        const bundled = await readBundledLogs(directory);
        expect(bundled).toContain('session_pull_requests.refresh_failed');
        expect(bundled).toContain('"errorName":"Error"');
        for (const value of privateStrings) expect(bundled).not.toContain(value);
    });
});
