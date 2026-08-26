import { execFileAsync } from '../../../../src/shared/node/exec';
import type { ProcessExplorerEntry, ProcessExplorerSnapshot } from '../shared/process-explorer';

const PROCESS_QUERY_TIMEOUT_MS = 2_000;
const PROCESS_QUERY_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_PROCESS_NAME_LENGTH = 4_096;

interface ElectronProcessSample {
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

interface ProcessExplorerSamplerOptions {
    electronProcesses: () => ElectronProcessSample[];
    processList?: ProcessListRunner;
    /**
     * OS process id -> role for Caxri's renderer windows. Electron's `getAppMetrics()` leaves `name` undefined for
     * `Tab` processes, so without this every renderer listed as a bare `window (renderer)` and the workbench was
     * distinguishable from the diagnostics window itself only by PID. Roles are supplied by Main rather than read from
     * window titles, which carry user Project names and change as the selection changes.
     */
    rendererRoles?: () => ReadonlyMap<number, string>;
    rootPid: number;
    hostPid?: () => number | undefined;
    runtimePid: () => number | undefined;
}

/**
 * Converts kilobytes to megabytes, rounded to one decimal place for display.
 */
export function kilobytesToMegabytes(kilobytes: number): number {
    return Math.round((kilobytes / 1024) * 10) / 10;
}

/**
 * Hides common credential flag values without removing the useful executable and argv context.
 */
export function redactProcessName(command: string): string {
    return command
        .replaceAll(
            /(-[\w-]*(?:api[-_]?key|authorization|password|secret|token)[\w-]*)(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/giu,
            '$1=<redacted>',
        )
        .slice(0, MAX_PROCESS_NAME_LENGTH);
}

export function parseProcessList(output: string): ProcessExplorerEntry[] {
    const processes: ProcessExplorerEntry[] = [];
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
    processes: ProcessExplorerEntry[],
    rootPid: number,
): ProcessExplorerEntry[] {
    const processesByPid = new Map(processes.map((process) => [process.pid, process] as const));
    const children = new Map<number, ProcessExplorerEntry[]>();
    for (const process of processes) {
        const siblings = children.get(process.parentPid) ?? [];
        siblings.push(process);
        children.set(process.parentPid, siblings);
    }
    const selected: ProcessExplorerEntry[] = [];
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

function electronProcessName(sample: ElectronProcessSample, rendererRole?: string): string {
    if (sample.type === 'Browser') return 'caxri';
    if (sample.type === 'Tab') return `window (${rendererRole ?? sample.name ?? 'renderer'})`;
    if (sample.type === 'GPU') return 'gpu-process';
    if (sample.type === 'Utility') {
        const detail = sample.name ?? sample.serviceName ?? 'process';
        return `utility-${detail
            .toLowerCase()
            .replaceAll(/[^a-z0-9]+/g, '-')
            .replaceAll(/^-|-$/g, '')}`;
    }
    return `${sample.type.toLowerCase().replaceAll(' ', '-')}${sample.name ? ` (${sample.name})` : ''}`;
}

async function runProcessList(): Promise<string> {
    const result = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,command='], {
        encoding: 'utf8',
        maxBuffer: PROCESS_QUERY_MAX_BUFFER_BYTES,
        timeout: PROCESS_QUERY_TIMEOUT_MS,
    });
    return result.stdout;
}

/**
 * Coalesces overlapping refreshes so a manual refresh cannot duplicate the periodic OS sample.
 */
export class ProcessExplorerSampler {
    private inFlight?: Promise<ProcessExplorerSnapshot>;

    constructor(private readonly options: ProcessExplorerSamplerOptions) {}

    private async load(): Promise<ProcessExplorerSnapshot> {
        const raw = parseProcessList(await (this.options.processList ?? runProcessList)()).filter(
            (process) => !process.name.includes('/bin/ps -axo'),
        );
        const hostPid = this.options.hostPid?.();
        const selected = new Map(
            [
                ...selectProcessTree(raw, this.options.rootPid),
                ...(hostPid ? selectProcessTree(raw, hostPid) : []),
            ].map((process) => [process.pid, process]),
        )
            .values()
            .toArray()
            .toSorted((left, right) => left.pid - right.pid);
        const electron = new Map(
            this.options.electronProcesses().map((sample) => [sample.pid, sample] as const),
        );
        const runtimePid = this.options.runtimePid();
        const rendererRoles = this.options.rendererRoles?.();
        return {
            processes: selected.map((process) => {
                const sample = electron.get(process.pid);
                if (process.pid === hostPid) return { ...process, name: 'host' };
                if (process.pid === runtimePid) return { ...process, name: 'runtime' };
                if (!sample) return process;
                return {
                    ...process,
                    name: electronProcessName(sample, rendererRoles?.get(process.pid)),
                    cpuPercent: sample.cpuPercent,
                    memoryMb: sample.memoryMb,
                };
            }),
            sampledAt: Date.now(),
        };
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
