import process from 'node:process';

import type { LogLevel } from '@caxri/protocol';
import { resolveLogLevel } from '@caxri/protocol';

interface LogLevelOptions {
    environment?: NodeJS.ProcessEnv;
    isPackaged: boolean;
}

/**
 * Packaged benchmarks retain debug records so observability assertions exercise the real logging paths.
 * `CAXRI_LOG_LEVEL` overrides the result for a packaged debugging session without a rebuild.
 */
export function resolveDesktopLogLevel({
    environment = process.env,
    isPackaged,
}: LogLevelOptions): LogLevel {
    return resolveLogLevel({
        environment,
        fallback: isPackaged && environment.CAXRI_E2E !== '1' ? 'info' : 'debug',
    });
}
