import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { RESULT_MARKER } from './server-database/marker';

const execFileAsync = promisify(execFile);
const RUNNER = join(import.meta.dirname, 'server-database', 'runner.ts');

/**
 * Runs `server-database/<name>.ts` (`run(input)`) in a Bun child process and returns its JSON result.
 *
 * Playwright's loader cannot resolve the Server migration manifest's `.sql?raw` imports, so seeds and reads that need
 * `apps/server/src/domains/db` must never be imported into a scenario; they live under `server-database/` and run
 * here.
 */
export async function runServerDatabase<Result>(name: string, input?: unknown): Promise<Result> {
    const { stdout } = await execFileAsync(
        'bun',
        [RUNNER, name, ...(input === undefined ? [] : [JSON.stringify(input)])],
        { maxBuffer: 64 * 1024 * 1024 },
    );
    const line = stdout.split('\n').findLast((entry) => entry.startsWith(RESULT_MARKER));
    if (line === undefined) throw new Error(`server-database "${name}" produced no result`);
    return JSON.parse(line.slice(RESULT_MARKER.length)) as Result;
}
