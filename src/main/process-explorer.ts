import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ProcessExplorerEntry, ProcessExplorerSnapshot } from '../shared/process-explorer';

const execFileAsync = promisify(execFile);
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
    rootPid: number;
    runtimePid: () => number | undefined;
}

/** Hides common credential flag values without removing the useful executable and argv context. */
export function redactProcessName(command: string): string {
    return command
        .replace(
            /(--?[\w-]*(?:api[-_]?key|authorization|password|secret|token)[\w-]*)(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/giu,
            '$1=<redacted>',
        )
        .slice(0, MAX_PROCESS_NAME_LENGTH);
}

export function parseProcessList(output: string): ProcessExplorerEntry[] {
    const processes: ProcessExplorerEntry[] = [];
    for (const line of output.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (!match) continue;
        const pid = Number(match[1]);
        const parentPid = Number(match[2]);
        const cpuPercent = Number(match[3]);
        const rssKb = Number(match[4]);
        if (![pid, parentPid, cpuPercent, rssKb].every(Number.isFinite) || pid <= 0) continue;
        processes.push({
            pid,
            parentPid,
            name: redactProcessName(match[5]),
            cpuPercent,
            memoryMb: Math.round((rssKb / 1024) * 10) / 10,
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
        for (const child of children.get(pid) ?? []) pending.push(child.pid);
    }
    return selected.sort((left, right) => left.pid - right.pid);
}

function electronProcessName(sample: ElectronProcessSample): string {
    if (sample.type === 'Browser') return 'caxri';
    if (sample.type === 'Tab') return `window (${sample.name ?? 'renderer'})`;
    if (sample.type === 'GPU') return 'gpu-process';
    if (sample.type === 'Utility') {
        const detail = sample.name ?? sample.serviceName ?? 'process';
        return `utility-${detail
            .toLowerCase()
            .replaceAll(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')}`;
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

/** Coalesces overlapping refreshes so a manual refresh cannot duplicate the periodic OS sample. */
export class ProcessExplorerSampler {
    private inFlight?: Promise<ProcessExplorerSnapshot>;

    constructor(private readonly options: ProcessExplorerSamplerOptions) {}

    snapshot(): Promise<ProcessExplorerSnapshot> {
        this.inFlight ??= this.load().finally(() => {
            this.inFlight = undefined;
        });
        return this.inFlight;
    }

    private async load(): Promise<ProcessExplorerSnapshot> {
        const raw = parseProcessList(await (this.options.processList ?? runProcessList)()).filter(
            (process) => !process.name.includes('/bin/ps -axo'),
        );
        const selected = selectProcessTree(raw, this.options.rootPid);
        const electron = new Map(
            this.options.electronProcesses().map((sample) => [sample.pid, sample] as const),
        );
        const runtimePid = this.options.runtimePid();
        return {
            processes: selected.map((process) => {
                const sample = electron.get(process.pid);
                if (process.pid === runtimePid) return { ...process, name: 'runtime' };
                if (!sample) return process;
                return {
                    ...process,
                    name: electronProcessName(sample),
                    cpuPercent: sample.cpuPercent,
                    memoryMb: sample.memoryMb,
                };
            }),
            sampledAt: Date.now(),
        };
    }
}
