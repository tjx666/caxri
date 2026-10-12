import { createHash } from 'node:crypto';

import { CaxriError, sshDestinationSchema } from '@caxri/protocol';

/**
 * An SSH destination split into the parts OpenSSH accepts as separate argv entries. `host` is either a `~/.ssh/config`
 * alias or a hostname/IP literal; `ssh` resolves aliases itself, so Desktop never reads `HostName`.
 */
export interface SshDestination {
    /**
     * The destination exactly as the user entered or chose it; the identity used for the ControlMaster path and the
     * recent list.
     */
    raw: string;
    host: string;
    port?: number;
    user?: string;
}

/**
 * Hostnames, aliases, and IPv4 literals. OpenSSH substitutes the host into `ProxyCommand` and other `%h` expansions run
 * by a shell, so anything outside this set (quotes, `$`, `;`, `|`, backticks) is refused even though argv alone would
 * carry it safely.
 */
const HOST_PATTERN = /^\w[\w.~+%-]*$/u;
/**
 * The body of a bracketed IPv6 literal, including an optional `%zone`.
 */
const IPV6_PATTERN = /^[0-9A-Fa-f:.]+(?:%[\w.-]+)?$/u;
/**
 * Login names. `@` is allowed because the user part ends at the last `@`, as OpenSSH splits it.
 */
const USER_PATTERN = /^[\w.][\w.@+-]*$/u;

function invalid(message: string): CaxriError {
    return new CaxriError('VALIDATION', message);
}

function parsePort(source: string): number {
    if (!/^\d{1,5}$/u.test(source)) throw invalid('SSH port must be a number');
    const port = Number(source);
    if (port < 1 || port > 65_535) throw invalid('SSH port must be between 1 and 65535');
    return port;
}

/**
 * Parses `alias`, `host`, `user@host`, `user@host:port`, `[v6]`, and `user@[v6]:port`. A bare IPv6 address without
 * brackets is accepted as a host with no port, since its colons cannot be told apart from a port separator.
 */
export function parseSshDestination(value: string): SshDestination {
    const validated = sshDestinationSchema.safeParse(value);
    if (!validated.success)
        throw invalid(validated.error.issues[0]?.message ?? 'SSH destination is invalid');
    const raw = validated.data;
    const at = raw.lastIndexOf('@');
    const user = at === -1 ? undefined : raw.slice(0, at);
    if (user !== undefined && !USER_PATTERN.test(user)) throw invalid('SSH user name is invalid');
    const rest = at === -1 ? raw : raw.slice(at + 1);

    let host: string;
    let port: number | undefined;
    if (rest.startsWith('[')) {
        const close = rest.indexOf(']');
        if (close === -1) throw invalid('SSH IPv6 address is missing "]"');
        host = rest.slice(1, close);
        if (!IPV6_PATTERN.test(host)) throw invalid('SSH IPv6 address is invalid');
        const suffix = rest.slice(close + 1);
        if (suffix !== '') {
            if (!suffix.startsWith(':')) throw invalid('SSH IPv6 address is invalid');
            port = parsePort(suffix.slice(1));
        }
    } else {
        const colons = rest.split(':').length - 1;
        if (colons === 1) {
            const separator = rest.indexOf(':');
            host = rest.slice(0, separator);
            port = parsePort(rest.slice(separator + 1));
        } else if (colons > 1) {
            host = rest;
            if (!IPV6_PATTERN.test(host)) throw invalid('SSH IPv6 address is invalid');
        } else {
            host = rest;
        }
        if (colons <= 1 && !HOST_PATTERN.test(host)) throw invalid('SSH host name is invalid');
    }
    if (host === '') throw invalid('SSH host name is empty');
    return {
        raw,
        host,
        ...(port !== undefined && { port }),
        ...(user !== undefined && { user }),
    };
}

/**
 * Trailing argv for one `ssh` invocation: port and user as their own options, then `--` so the host can never be read
 * as an option even if a future parser change let a `-` through. Anything after this (a remote command) follows the
 * host.
 */
export function sshDestinationArguments(destination: SshDestination): string[] {
    return [
        ...(destination.port === undefined ? [] : ['-p', String(destination.port)]),
        ...(destination.user === undefined ? [] : ['-l', destination.user]),
        '--',
        destination.host,
    ];
}

/**
 * Stable 12-hex identity of a destination and the config file it is resolved with; the prefix of its ControlMaster
 * socket names, so a test config override never collides with the user's own connection to the same destination.
 */
export function sshDestinationKey(destination: SshDestination, configFile?: string): string {
    return createHash('sha256')
        .update(`${destination.raw}\0${configFile ?? ''}`)
        .digest('hex')
        .slice(0, 12);
}

/**
 * Identifies one SSH Host across spellings (`dev@box` and `dev@box:22`), so a second connect focuses the existing
 * window instead of opening another one that would replace its Desktop lease on the shared remote Server. This is the
 * fallback when `ssh -G` cannot resolve aliases; see `resolveSshHostWindowKey`.
 */
export function sshHostWindowKey(destination: SshDestination): string {
    return `${destination.user ?? ''}@${destination.host}:${destination.port ?? 22}`;
}
