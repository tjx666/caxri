import { execFileAsync, safeProcessEnvironment } from '@caxri/system';

const LSOF_TIMEOUT_MS = 3_000;
const MAX_LSOF_BYTES = 4 * 1024 * 1024;

/**
 * One listening TCP socket. `host` is the loopback or concrete address a client on this computer connects to: a
 * wildcard bind (`*`, `0.0.0.0`, `[::]`) maps to the loopback of its own address family.
 */
export interface ListeningSocket {
    host: string;
    pid: number;
    port: number;
    processName: string;
}

const connectableHost = (address: string, family: string | undefined): string | undefined => {
    if (address === '*') return family === 'IPv6' ? '::1' : '127.0.0.1';
    if (address === '0.0.0.0') return '127.0.0.1';
    if (address.startsWith('[') && address.endsWith(']')) {
        const inner = address.slice(1, -1);
        return inner === '::' ? '::1' : inner;
    }
    return /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(address) ? address : undefined;
};

interface LsofProcessState {
    family: string | undefined;
    pid: number;
    processName: string;
}

const listeningSocket = (name: string, state: LsofProcessState): ListeningSocket | undefined => {
    const separator = name.lastIndexOf(':');
    const port = Number(name.slice(separator + 1));
    if (separator <= 0 || state.pid <= 0 || !state.processName) return undefined;
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) return undefined;
    const host = connectableHost(name.slice(0, separator), state.family);
    return host ? { host, pid: state.pid, port, processName: state.processName } : undefined;
};

const readListeningLine = (
    line: string,
    state: LsofProcessState,
    sockets: ListeningSocket[],
): void => {
    const value = line.slice(1);
    switch (line.slice(0, 1)) {
        case 'p':
            state.pid = Number(value);
            state.processName = '';
            state.family = undefined;
            return;
        case 'c':
            state.processName = value.slice(0, 64);
            return;
        case 'f':
            state.family = undefined;
            return;
        case 't':
            state.family = value;
            return;
        case 'n': {
            const socket = listeningSocket(value, state);
            if (socket) sockets.push(socket);
            return;
        }
        default:
    }
};

/**
 * Parses `lsof -nP -iTCP -sTCP:LISTEN -F pcnt`: a `p` line opens each process, `c` names it, and every file contributes
 * `t` (address family) then `n` (`address:port`). Sockets whose address is not numeric are dropped.
 */
export function parseLsofListeningSockets(output: string): ListeningSocket[] {
    const sockets: ListeningSocket[] = [];
    const state: LsofProcessState = { family: undefined, pid: 0, processName: '' };
    for (const line of output.split('\n')) readListeningLine(line, state, sockets);
    return sockets;
}

/**
 * Parses `lsof -a -d cwd -F pn -p <pids>` into each process's working directory.
 */
export function parseLsofWorkingDirectories(output: string): Map<number, string> {
    const directories = new Map<number, string>();
    let pid = 0;
    for (const line of output.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1));
        else if (line.startsWith('n') && pid > 0 && line.length > 1)
            directories.set(pid, line.slice(1));
    }
    return directories;
}

/**
 * `lsof` exits 1 when one of its selections matched nothing, while still printing every match it found.
 */
const runLsof = async (arguments_: string[]): Promise<string> => {
    try {
        const { stdout } = await execFileAsync('lsof', arguments_, {
            env: safeProcessEnvironment(),
            maxBuffer: MAX_LSOF_BYTES,
            timeout: LSOF_TIMEOUT_MS,
        });
        return stdout;
    } catch (error) {
        const stdout = (error as { stdout?: unknown }).stdout;
        if (typeof stdout === 'string' && (error as { code?: unknown }).code === 1) return stdout;
        throw error;
    }
};

export interface ListeningProcesses {
    sockets: ListeningSocket[];
    workingDirectories: Map<number, string>;
}

/**
 * Every listening TCP socket on this computer and the working directory of each process that owns one. Two `lsof` runs:
 * the first finds the listeners, the second reads only those processes' `cwd`.
 */
export async function readListeningProcesses(): Promise<ListeningProcesses> {
    const sockets = parseLsofListeningSockets(
        await runLsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcnt']),
    );
    const pids = [...new Set(sockets.map((socket) => socket.pid))];
    const workingDirectories =
        pids.length === 0
            ? new Map<number, string>()
            : parseLsofWorkingDirectories(
                  await runLsof(['-a', '-d', 'cwd', '-F', 'pn', '-p', pids.join(',')]),
              );
    return { sockets, workingDirectories };
}
