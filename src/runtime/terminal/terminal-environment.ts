import process from 'node:process';

import { safeProcessEnvironment } from '../../shared/node/process-environment';

/**
 * Builds the environment for a spawned PTY: the sanitized process environment plus the terminal capabilities Caxri
 * guarantees to shells and agents (`TERM`/`COLORTERM`).
 */
export function terminalEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
        ...safeProcessEnvironment(source),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
    };
    return environment;
}
