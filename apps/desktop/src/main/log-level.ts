import process from 'node:process';

interface LogLevelOptions {
    environment?: NodeJS.ProcessEnv;
    isPackaged: boolean;
}

/**
 * Packaged benchmarks retain debug records so observability assertions exercise the real logging paths.
 */
export function resolveLogLevel({
    environment = process.env,
    isPackaged,
}: LogLevelOptions): 'debug' | 'info' {
    return isPackaged && environment.CAXRI_E2E !== '1' ? 'info' : 'debug';
}
