import process from 'node:process';

import { safeProcessEnvironment } from '@caxri/system';

/**
 * Builds the environment for a spawned PTY: the sanitized process environment plus the terminal capabilities Caxri
 * guarantees to shells and agents (`TERM`/`COLORTERM`).
 */
export function terminalEnvironment(
    source: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
        ...safeProcessEnvironment(source),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
    };
    /**
     * A Server started over SSH on a Linux host often has no locale at all, and the C locale renders every non-ASCII
     * character an Agent TUI draws as mojibake. `C.UTF-8` ships with every glibc distribution, so it is a safe floor
     * that never overrides a locale the user configured.
     */
    if (platform === 'linux' && !environment.LANG && !environment.LC_ALL && !environment.LC_CTYPE)
        environment.LANG = 'C.UTF-8';
    return environment;
}
