import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

import type { AgentProvider } from '../../shared/agents';
import { agentProviderCatalog, agentProviderIds } from '../../shared/agents';

const execFileAsync = promisify(execFile);
const PROCESS_QUERY_TIMEOUT_MS = 2_000;
const PROCESS_QUERY_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

interface ProcessEntry {
    command: string;
    parentPid: number;
    pgid: number;
    pid: number;
    terminalForegroundPgid: number;
}

const providerByExecutableName = new Map<string, AgentProvider>(
    agentProviderIds.map((provider) => [agentProviderCatalog[provider].executableName, provider]),
);

function parseProcessList(output: string): ProcessEntry[] {
    const processes: ProcessEntry[] = [];
    for (const line of output.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S.*)$/.exec(line);
        if (!match) continue;
        const [pid, parentPid, pgid, terminalForegroundPgid] = match.slice(1, 5).map(Number);
        if (![pid, parentPid, pgid, terminalForegroundPgid].every(Number.isFinite) || pid <= 0)
            continue;
        processes.push({
            pid,
            parentPid,
            pgid,
            terminalForegroundPgid,
            command: match[5].trimEnd(),
        });
    }
    return processes;
}

function commandProvider(command: string): AgentProvider | undefined {
    const executable = command
        .match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)
        ?.slice(1)
        .find(Boolean);
    return executable ? providerByExecutableName.get(basename(executable)) : undefined;
}

/**
 * Identifies an Agent only when its executable belongs to the Shell PTY's active foreground process group. This
 * resolves shell aliases without reading shell configuration or mistaking a background Agent in the same process tree
 * for the command the user just submitted.
 */
export function foregroundAgentProviderFromProcessList(
    output: string,
    shellPid: number,
): AgentProvider | undefined {
    const processes = parseProcessList(output);
    const processesByPid = new Map(processes.map((process) => [process.pid, process] as const));
    const shell = processesByPid.get(shellPid);
    if (!shell || shell.terminalForegroundPgid <= 0) return undefined;

    const children = new Map<number, ProcessEntry[]>();
    for (const process of processes) {
        const siblings = children.get(process.parentPid) ?? [];
        siblings.push(process);
        children.set(process.parentPid, siblings);
    }

    const providers = new Set<AgentProvider>();
    const pending = [shellPid];
    const visited = new Set<number>();
    while (pending.length > 0) {
        const pid = pending.shift()!;
        if (visited.has(pid)) continue;
        visited.add(pid);
        const process = processesByPid.get(pid);
        if (process?.pgid === shell.terminalForegroundPgid) {
            const provider = commandProvider(process.command);
            if (provider) providers.add(provider);
        }
        const siblings = children.get(pid) ?? [];
        for (const child of siblings) pending.push(child.pid);
    }
    return providers.size === 1 ? [...providers][0] : undefined;
}

/**
 * Reads process identity only; the output is never logged, persisted, or sent to the Renderer.
 */
export async function detectForegroundAgentProvider(
    shellPid: number,
): Promise<AgentProvider | undefined> {
    const result = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,command='], {
        encoding: 'utf8',
        maxBuffer: PROCESS_QUERY_MAX_BUFFER_BYTES,
        timeout: PROCESS_QUERY_TIMEOUT_MS,
    });
    return foregroundAgentProviderFromProcessList(result.stdout, shellPid);
}
