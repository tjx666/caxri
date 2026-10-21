import { join } from 'node:path';

import { atomicWriteFile } from '@caxri/system';

/**
 * Single-quotes a value for POSIX `sh`, so a path with spaces or quotes reaches `exec` as one argument.
 */
function shellQuote(value: string): string {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Writes `<userData>/bin/caxri`, the launcher Caxri-managed Agents run the version-matched CLI through (exported to
 * them as `CAXRI_CLI`).
 *
 * `node "$CAXRI_CLI_PATH"` needed a `node` on `PATH`, which an SSH Host often lacks, and Desktop's packaged Server runs
 * on Electron rather than Node. The launcher execs the CLI bundle with the runtime this Server Core itself runs on, so
 * it neither depends on nor shadows a user-installed Node. `ELECTRON_RUN_AS_NODE` is ignored by a plain Node runtime.
 *
 * The file is rewritten on every Server start (one Server owns a profile at a time) and replaced by rename, so an Agent
 * running it mid-write never sees a partial script.
 */
export async function writeCliLauncher({
    cliPath,
    executable,
    userDataPath,
}: {
    cliPath: string;
    executable: string;
    userDataPath: string;
}): Promise<string> {
    const path = join(userDataPath, 'bin', 'caxri');
    await atomicWriteFile(
        path,
        `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(executable)} ${shellQuote(cliPath)} "$@"\n`,
        { durability: 'file', exactMode: true, mode: 0o755 },
    );
    return path;
}
