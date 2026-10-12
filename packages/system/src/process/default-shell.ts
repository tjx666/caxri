import { userInfo } from 'node:os';
import process from 'node:process';

/**
 * System shells to fall back to, in order, when the user's configured shell is missing or unset. macOS ships zsh as the
 * default login shell; Linux distributions guarantee only a POSIX `sh`, and stock Debian or Ubuntu do not install zsh
 * at all, so a hard-coded `/bin/zsh` leaves a Server on an SSH Host without a runnable Terminal.
 */
export function systemShellCandidates(
    platform: NodeJS.Platform = process.platform,
): readonly string[] {
    return platform === 'darwin' ? ['/bin/zsh', '/bin/bash', '/bin/sh'] : ['/bin/bash', '/bin/sh'];
}

/**
 * The account's login shell from the password database. A Server started over SSH by a non-login launcher, or by a
 * service manager, may not inherit `SHELL`, while the account record is still authoritative.
 */
export function accountShell(): string | undefined {
    try {
        // `||` (not `??`): an empty shell field is not runnable either.
        // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string is not a valid shell path
        return userInfo().shell || undefined;
    } catch {
        return undefined;
    }
}

/**
 * The shell a Terminal or login probe should run when nothing more specific is configured: `SHELL`, then the account's
 * login shell, then the platform's first system shell.
 */
export function preferredShell(environment: NodeJS.ProcessEnv = process.env): string {
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string is not a valid shell path
    return environment.SHELL || accountShell() || systemShellCandidates()[0];
}
