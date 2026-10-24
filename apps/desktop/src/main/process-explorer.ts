import type { TerminalProcessEntry } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';
import { redactCommandLine } from '@caxri/utils';

import type { ProcessExplorerEntry, ProcessExplorerSnapshot } from '../shared/process-explorer';

const PROCESS_QUERY_TIMEOUT_MS = 2_000;
const PROCESS_QUERY_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_PROCESS_NAME_LENGTH = 4_096;
const SERVER_CHILD_PROCESS_MARKERS = [
    { marker: '/bundles/extension-host.js', name: 'Extension Host' },
    { marker: '/bundles/terminal-host.js', name: 'Terminal Host' },
] as const;

export interface ElectronProcessSample {
    cpuPercent: number;
    memoryMb: number;
    name?: string;
    pid: number;
    serviceName?: string;
    type:
        | 'Browser'
        | 'GPU'
        | 'Pepper Plugin'
        | 'Pepper Plugin Broker'
        | 'Sandbox helper'
        | 'Tab'
        | 'Unknown'
        | 'Utility'
        | 'Zygote';
}

type ProcessListRunner = () => Promise<string>;

/**
 * One `ps` row before Caxri names it: `name` still holds the redacted command line.
 */
export interface RawProcessEntry {
    cpuPercent: number;
    memoryMb: number;
    name: string;
    parentPid: number;
    pid: number;
}

interface ProcessExplorerSamplerOptions {
    electronProcesses: () => ElectronProcessSample[];
    processList?: ProcessListRunner;
    /**
     * OS process id -> role for Caxri's renderer windows. Electron's `getAppMetrics()` leaves `name` undefined for
     * `Tab` processes, so without this every renderer listed as a bare window and the workbench was distinguishable
     * from the diagnostics window itself only by PID. Roles are supplied by Main rather than read from window titles,
     * which carry user Project names and change as the selection changes.
     */
    rendererRoles?: () => ReadonlyMap<number, string>;
    rootPid: number;
    serverPid?: () => number | undefined;
    systemMemoryMb?: () => number;
    /**
     * Running Terminals with their PTY root PIDs, from Server Core. A failure degrades to an ungrouped list rather than
     * failing the whole sample.
     */
    terminals?: () => Promise<TerminalProcessEntry[]>;
}

/**
 * Converts kilobytes to megabytes, rounded to one decimal place for display.
 */
export function kilobytesToMegabytes(kilobytes: number): number {
    return Math.round((kilobytes / 1024) * 10) / 10;
}

/**
 * Hides credential flag values without removing the useful executable and argv context. The flag rule is the shared
 * `redactCommandLine` so the Process Explorer and the diagnostics export cannot disagree about what counts as a
 * secret.
 */
export function redactProcessName(command: string): string {
    return redactCommandLine(command, '<redacted>').slice(0, MAX_PROCESS_NAME_LENGTH);
}

export function parseProcessList(output: string): RawProcessEntry[] {
    const processes: RawProcessEntry[] = [];
    for (const rawLine of output.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        // Split on whitespace instead of a single regex with adjacent unbounded `\s+`/`.+?`
        // quantifiers, which is vulnerable to super-linear backtracking on crafted input.
        const [pidText, parentPidText, cpuText, rssText, ...commandParts] = line.split(/\s+/);
        if (commandParts.length === 0) continue;
        const pid = Number(pidText);
        const parentPid = Number(parentPidText);
        const cpuPercent = Number(cpuText);
        const rssKb = Number(rssText);
        if (![pid, parentPid, cpuPercent, rssKb].every(Number.isFinite) || pid <= 0) continue;
        processes.push({
            pid,
            parentPid,
            name: redactProcessName(commandParts.join(' ')),
            cpuPercent,
            memoryMb: kilobytesToMegabytes(rssKb),
        });
    }
    return processes;
}

export function selectProcessTree(
    processes: RawProcessEntry[],
    rootPid: number,
): RawProcessEntry[] {
    const processesByPid = new Map(processes.map((process) => [process.pid, process] as const));
    const children = new Map<number, RawProcessEntry[]>();
    for (const process of processes) {
        const siblings = children.get(process.parentPid) ?? [];
        siblings.push(process);
        children.set(process.parentPid, siblings);
    }
    const selected: RawProcessEntry[] = [];
    const pending = [rootPid];
    const visited = new Set<number>();
    while (pending.length > 0) {
        const pid = pending.shift()!;
        if (visited.has(pid)) continue;
        visited.add(pid);
        const process = processesByPid.get(pid);
        if (process) selected.push(process);
        const childProcesses = children.get(pid) ?? [];
        for (const child of childProcesses) pending.push(child.pid);
    }
    return selected.toSorted((left, right) => left.pid - right.pid);
}

const INTERPRETERS = new Set(['bun', 'deno', 'node', 'perl', 'python', 'python3', 'ruby']);
const INTERPRETER_SUBCOMMANDS = new Set(['exec', 'run', 'x']);

function basename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Names a process after what it runs instead of where it lives: `/Users/me/.local/bin/claude --resume <id>` reads as
 * `claude`, and an interpreter reads as interpreter plus script (`node agent-launcher.js`, `bun watch-pr.ts`) because
 * the interpreter alone says nothing. The full command line stays available as `command`.
 *
 * Splitting on whitespace misreads an executable path that itself contains a space; the result is then a shorter but
 * still recognizable name, and hover shows the exact command.
 */
export function processDisplayName(command: string): string {
    const tokens = command.trim().split(/\s+/);
    // `ps` wraps a process that is exiting or has not exec'd yet in parentheses, e.g. `(git)`.
    const executable = basename(tokens[0].replace(/^\((.*)\)$/, '$1')).replace(/^-/, '');
    if (!INTERPRETERS.has(executable)) return executable || command;
    const scriptArguments = tokens.slice(1).filter((token) => !token.startsWith('-'));
    const script = INTERPRETER_SUBCOMMANDS.has(scriptArguments[0] ?? '')
        ? scriptArguments[1]
        : scriptArguments[0];
    return script ? `${executable} ${basename(script)}` : executable;
}

const RENDERER_ROLE_NAMES: Readonly<Record<string, string>> = {
    'agent commander': 'Agent Commander',
    'performance monitor': 'Performance Monitor',
    'process explorer': 'Process Explorer',
    'workbench': 'Workbench',
};

function electronProcessIdentity(
    sample: ElectronProcessSample,
    rendererRole?: string,
): Pick<ProcessExplorerEntry, 'kind' | 'name'> {
    if (sample.type === 'Browser') return { kind: 'main', name: 'Caxri' };
    if (sample.type === 'Tab')
        return {
            kind: 'window',
            name: (rendererRole && RENDERER_ROLE_NAMES[rendererRole]) ?? sample.name ?? 'Renderer',
        };
    if (sample.type === 'GPU') return { kind: 'gpu', name: 'GPU' };
    return { kind: 'helper', name: sample.name ?? sample.serviceName ?? sample.type };
}

async function runProcessList(): Promise<string> {
    const result = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,command='], {
        encoding: 'utf8',
        maxBuffer: PROCESS_QUERY_MAX_BUFFER_BYTES,
        timeout: PROCESS_QUERY_TIMEOUT_MS,
    });
    return result.stdout;
}

const SERVER_CORE_NAME = 'Server Core';

function serverProcessName(
    process: RawProcessEntry,
    serverPid: number | undefined,
): string | undefined {
    if (process.pid === serverPid) return SERVER_CORE_NAME;
    if (process.parentPid !== serverPid) return;
    return SERVER_CHILD_PROCESS_MARKERS.find(({ marker }) => process.name.includes(marker))?.name;
}

/**
 * Coalesces overlapping refreshes so a manual refresh cannot duplicate the periodic OS sample.
 */
export class ProcessExplorerSampler {
    private inFlight?: Promise<ProcessExplorerSnapshot>;

    constructor(private readonly options: ProcessExplorerSamplerOptions) {}

    private async load(): Promise<ProcessExplorerSnapshot> {
        const terminals = this.loadTerminals();
        const raw = parseProcessList(await (this.options.processList ?? runProcessList)()).filter(
            (process) => !process.name.includes('/bin/ps -axo'),
        );
        const serverPid = this.options.serverPid?.();
        const selected = new Map(
            [
                ...selectProcessTree(raw, this.options.rootPid),
                ...(serverPid ? selectProcessTree(raw, serverPid) : []),
            ].map((process) => [process.pid, process]),
        )
            .values()
            .toArray()
            .toSorted((left, right) => left.pid - right.pid);
        const electron = new Map(
            this.options.electronProcesses().map((sample) => [sample.pid, sample] as const),
        );
        const rendererRoles = this.options.rendererRoles?.();
        return {
            processes: selected.map((process): ProcessExplorerEntry => {
                const base = {
                    pid: process.pid,
                    parentPid: process.parentPid,
                    cpuPercent: process.cpuPercent,
                    memoryMb: process.memoryMb,
                };
                const ownedName = serverProcessName(process, serverPid);
                if (ownedName) return { ...base, kind: 'service', name: ownedName };
                const sample = electron.get(process.pid);
                if (!sample)
                    return {
                        ...base,
                        kind: 'process',
                        name: processDisplayName(process.name),
                        command: process.name,
                    };
                return {
                    ...base,
                    ...electronProcessIdentity(sample, rendererRoles?.get(process.pid)),
                    cpuPercent: sample.cpuPercent,
                    memoryMb: sample.memoryMb,
                };
            }),
            terminals: await terminals,
            systemMemoryMb: this.options.systemMemoryMb?.() ?? 0,
            sampledAt: Date.now(),
        };
    }

    private async loadTerminals(): Promise<TerminalProcessEntry[]> {
        try {
            return (await this.options.terminals?.()) ?? [];
        } catch {
            // Server Core restarting or unreachable: show the processes ungrouped rather than no processes at all.
            return [];
        }
    }

    /**
     * `this.inFlight` coalesces overlapping refreshes: every concurrent caller shares and awaits the same in-flight
     * promise, so this method returns it directly rather than awaiting it itself before returning.
     */
    snapshot(): Promise<ProcessExplorerSnapshot> {
        // eslint-disable-next-line unicorn/prefer-await -- see JSDoc above, coalescing requires the shared promise itself
        this.inFlight ??= this.load().finally(() => {
            this.inFlight = undefined;
        });
        return this.inFlight;
    }
}
