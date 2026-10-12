import process from 'node:process';

import { execFileAsync } from '@caxri/system';

import { parseSshDestination, sshDestinationArguments, sshHostWindowKey } from './destination';
import { DEFAULT_SSH_EXECUTABLE } from './ssh-connection';

/**
 * `ssh -G` only evaluates the config; it never connects. The bound covers a `Match exec` command that hangs.
 */
const RESOLVE_TIMEOUT_MS = 5000;

export interface ResolveSshHostWindowKeyOptions {
    /**
     * The `-F` config file every `ssh` call for this destination uses, so resolution reads the same aliases.
     */
    configFile?: string;
    /**
     * Runs `ssh` with `args` and resolves its stdout; tests substitute canned `ssh -G` output.
     */
    run?: (arguments_: string[]) => Promise<string>;
}

/**
 * Reads the effective `user@hostname:port` from `ssh -G` output, which prints one lowercase `keyword value` pair per
 * line. Returns `undefined` when any of the three is missing or malformed.
 */
export function parseSshEffectiveTarget(output: string): string | undefined {
    const values = new Map<string, string>();
    for (const line of output.split('\n')) {
        const [keyword, value] = line.trim().split(/\s+/u, 2);
        if (keyword && value && !values.has(keyword)) values.set(keyword, value);
    }
    const hostname = values.get('hostname');
    const user = values.get('user');
    const port = values.get('port');
    if (!hostname || !user || !port || !/^\d{1,5}$/u.test(port)) return undefined;
    return `${user}@${hostname}:${Number(port)}`;
}

async function runSsh(arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync(DEFAULT_SSH_EXECUTABLE, arguments_, {
        env: process.env,
        timeout: RESOLVE_TIMEOUT_MS,
    });
    return stdout;
}

/**
 * The SSH Host window identity of `destination`. Two `~/.ssh/config` aliases for the same account resolve, through `ssh
 * -G`, to the same `user@hostname:port` and so share one window instead of contending for one remote Server. When `ssh
 * -G` fails or prints something unexpected, the key falls back to the destination's own spelling
 * ({@link sshHostWindowKey}). An invalid destination still throws, before anything runs.
 */
export async function resolveSshHostWindowKey(
    destination: string,
    options: ResolveSshHostWindowKeyOptions = {},
): Promise<string> {
    const parsed = parseSshDestination(destination);
    const run = options.run ?? runSsh;
    try {
        const output = await run([
            ...(options.configFile === undefined ? [] : ['-F', options.configFile]),
            '-G',
            ...sshDestinationArguments(parsed),
        ]);
        const resolved = parseSshEffectiveTarget(output);
        if (resolved) return resolved;
    } catch {
        // An unreadable config or a missing `ssh` binary keeps the spelling-based key below.
    }
    return sshHostWindowKey(parsed);
}
