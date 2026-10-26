import { execFileAsync } from '../filesystem/exec.js';
import { safeProcessEnvironment } from './environment.js';

const PROCESS_TABLE_TIMEOUT_MS = 2_000;
const MAX_PROCESS_TABLE_BYTES = 4 * 1024 * 1024;

/**
 * One row of `ps -axo pid=,ppid=,pcpu=,rss=`: the numbers a resource reading needs. The command line is present only
 * when the sample asked for it (`includeCommand`).
 */
export interface ProcessTableEntry {
    pid: number;
    parentPid: number;
    /**
     * `ps` `%cpu`. On macOS this is a decaying average over up to a minute of real time, not an instantaneous value.
     */
    cpuPercent: number;
    rssKb: number;
    /**
     * The raw, unredacted command line. Callers must reduce it (for example with `processDisplayName`) before it leaves
     * the process.
     */
    command?: string;
}

export interface ProcessTreeUsage {
    cpuPercent: number;
    memoryMb: number;
    /**
     * The root plus every descendant.
     */
    processCount: number;
}

export function parseProcessTable(output: string): ProcessTableEntry[] {
    return output.split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s*$/.exec(line);
        if (!match) return [];
        const [pid, parentPid, cpuPercent, rssKb] = match.slice(1).map(Number);
        if (![pid, parentPid, cpuPercent, rssKb].every(Number.isFinite) || pid <= 0) return [];
        return [{ pid, parentPid, cpuPercent, rssKb }];
    });
}

/**
 * Parses `ps -axo pid=,ppid=,pcpu=,rss=,command=`. Splits on whitespace instead of one regex with a trailing unbounded
 * command group, which would backtrack super-linearly on crafted input.
 */
export function parseProcessTableWithCommands(output: string): ProcessTableEntry[] {
    return output.split('\n').flatMap((rawLine) => {
        const line = rawLine.trim();
        if (!line) return [];
        const [pidText, parentPidText, cpuText, rssText, ...commandParts] = line.split(/\s+/);
        if (commandParts.length === 0) return [];
        const [pid, parentPid, cpuPercent, rssKb] = [pidText, parentPidText, cpuText, rssText].map(
            Number,
        );
        if (![pid, parentPid, cpuPercent, rssKb].every(Number.isFinite) || pid <= 0) return [];
        return [{ pid, parentPid, cpuPercent, rssKb, command: commandParts.join(' ') }];
    });
}

/**
 * Indexes a sample once so many roots can be summarized against it without rebuilding the parent map per root.
 */
export class ProcessTable {
    private readonly byPid: Map<number, ProcessTableEntry>;
    private readonly children = new Map<number, number[]>();

    constructor(entries: readonly ProcessTableEntry[]) {
        this.byPid = new Map(entries.map((entry) => [entry.pid, entry]));
        for (const entry of entries) {
            const siblings = this.children.get(entry.parentPid) ?? [];
            siblings.push(entry.pid);
            this.children.set(entry.parentPid, siblings);
        }
    }

    /**
     * Every sampled process, in `ps` order.
     */
    entries(): ProcessTableEntry[] {
        return this.byPid.values().toArray();
    }

    get(pid: number): ProcessTableEntry | undefined {
        return this.byPid.get(pid);
    }

    /**
     * The root and all its descendants, or an empty list once the root has exited.
     */
    tree(rootPid: number): ProcessTableEntry[] {
        if (!this.byPid.has(rootPid)) return [];
        const visited = new Set<number>();
        const pending = [rootPid];
        while (pending.length > 0) {
            const pid = pending.pop()!;
            if (visited.has(pid)) continue;
            visited.add(pid);
            pending.push(...(this.children.get(pid) ?? []));
        }
        return [...visited].flatMap((pid) => {
            const entry = this.byPid.get(pid);
            return entry ? [entry] : [];
        });
    }

    usage(rootPid: number): ProcessTreeUsage | null {
        const tree = this.tree(rootPid);
        if (tree.length === 0) return null;
        const rssKb = tree.reduce((total, entry) => total + entry.rssKb, 0);
        const cpuPercent = tree.reduce((total, entry) => total + entry.cpuPercent, 0);
        return {
            cpuPercent: Math.round(cpuPercent * 10) / 10,
            memoryMb: Math.round((rssKb / 1024) * 10) / 10,
            processCount: tree.length,
        };
    }
}

/**
 * One `ps` call covering every process on the machine; callers summarize whichever trees they own from it.
 * `includeCommand` adds each command line, for a caller that names processes; resource monitors leave it off so a
 * sample stays a few kilobytes.
 */
export async function sampleProcessTable(
    options: { includeCommand?: boolean } = {},
): Promise<ProcessTable> {
    const columns = options.includeCommand
        ? 'pid=,ppid=,pcpu=,rss=,command='
        : 'pid=,ppid=,pcpu=,rss=';
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', columns], {
        encoding: 'utf8',
        env: safeProcessEnvironment(),
        maxBuffer: MAX_PROCESS_TABLE_BYTES,
        timeout: PROCESS_TABLE_TIMEOUT_MS,
    });
    return new ProcessTable(
        options.includeCommand ? parseProcessTableWithCommands(stdout) : parseProcessTable(stdout),
    );
}

/**
 * Server Core's long-lived child processes, recognized by the bundle each one runs.
 */
export type ServerHostRole = 'extensionHost' | 'terminalHost';

const SERVER_HOST_BUNDLES: ReadonlyArray<{ marker: string; role: ServerHostRole }> = [
    { marker: '/bundles/extension-host.js', role: 'extensionHost' },
    { marker: '/bundles/terminal-host.js', role: 'terminalHost' },
];

/**
 * Which Server Core host a child process is, from its command line. Callers check the parent PID themselves; a command
 * line alone could belong to another installation's Server.
 */
export function serverHostRole(command: string): ServerHostRole | undefined {
    return SERVER_HOST_BUNDLES.find(({ marker }) => command.includes(marker))?.role;
}
