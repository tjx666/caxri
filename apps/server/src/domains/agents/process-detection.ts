import { basename } from 'node:path';
import process from 'node:process';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';

const PROCESS_QUERY_TIMEOUT_MS = 2_000;
const PROCESS_QUERY_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const OPEN_FILE_QUERY_TIMEOUT_MS = 1_000;
const OPEN_FILE_QUERY_MAX_BUFFER_BYTES = 512 * 1024;
const MAX_FOREGROUND_AGENT_PROCESSES = 64;

interface ProcessEntry {
    command: string;
    parentPid: number;
    pgid: number;
    pid: number;
    terminalForegroundPgid: number;
}

export interface ProcessOpenFile {
    access: string;
    path: string;
    pid: number;
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

/**
 * Npm/pnpm-installed agent CLIs run via a shell shim that `exec`s the interpreter directly, so their process image is
 * `node <path>/codex.js` instead of an executable named after the provider. Unwrapping one interpreter level keeps
 * those installs detectable.
 */
const interpreterBasenames = new Set(['bun', 'deno', 'node', 'nodejs']);
const scriptExtensionPattern = /\.(?:cjs|mjs|js|ts)$/i;

function commandTokens(command: string): string[] {
    const tokens: string[] = [];
    for (const match of command.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)) {
        tokens.push(match.slice(1).find(Boolean)!);
        if (tokens.length >= 8) break;
    }
    return tokens;
}

function commandProvider(command: string): AgentProvider | undefined {
    const tokens = commandTokens(command);
    if (tokens.length === 0) return undefined;
    const executable = basename(tokens[0]);
    const direct = providerByExecutableName.get(executable);
    if (direct) return direct;
    if (!interpreterBasenames.has(executable)) return undefined;
    const script = tokens.slice(1).find((token) => !token.startsWith('-'));
    if (!script) return undefined;
    return providerByExecutableName.get(basename(script).replace(scriptExtensionPattern, ''));
}

interface ForegroundAgentProcesses {
    pids: number[];
    provider: AgentProvider;
}

function foregroundAgentProcessesFromProcessList(
    output: string,
    shellPid: number,
): ForegroundAgentProcesses | undefined {
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
    const pids: number[] = [];
    const pending = [shellPid];
    const visited = new Set<number>();
    while (pending.length > 0) {
        const pid = pending.shift()!;
        if (visited.has(pid)) continue;
        visited.add(pid);
        const process = processesByPid.get(pid);
        if (process?.pgid === shell.terminalForegroundPgid) {
            const provider = commandProvider(process.command);
            if (provider) {
                providers.add(provider);
                pids.push(process.pid);
            }
        }
        const siblings = children.get(pid) ?? [];
        for (const child of siblings) pending.push(child.pid);
    }
    if (providers.size !== 1 || pids.length > MAX_FOREGROUND_AGENT_PROCESSES) return undefined;
    return { pids, provider: [...providers][0] };
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
    return foregroundAgentProcessesFromProcessList(output, shellPid)?.provider;
}

/**
 * Identifies every foreground process image belonging to one provider. The returned PIDs are restricted to the PTY
 * process tree and its active foreground process group, so a Codex process from another Terminal cannot contribute an
 * open provider file to this probe.
 */
export function foregroundAgentProcessIdsFromProcessList(
    output: string,
    shellPid: number,
    provider: AgentProvider,
): number[] | undefined {
    const processes = foregroundAgentProcessesFromProcessList(output, shellPid);
    return processes?.provider === provider ? processes.pids : undefined;
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

/**
 * Parses the content-free fields emitted by `lsof -Fpfan`. File contents and terminal output never cross this boundary.
 */
export function openFilesFromLsofOutput(output: string): ProcessOpenFile[] {
    const files: ProcessOpenFile[] = [];
    let pid: number | undefined;
    let access = '';
    for (const line of output.split('\n')) {
        if (line.length < 2) continue;
        const field = line[0];
        const value = line.slice(1);
        if (field === 'p') {
            const parsed = Number(value);
            pid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
            access = '';
            continue;
        }
        if (field === 'f') {
            access = '';
            continue;
        }
        if (field === 'a') {
            access = value.trim();
            continue;
        }
        if (field === 'n' && pid !== undefined && value.length > 0) {
            files.push({ access, path: value, pid });
        }
    }
    return files;
}

/**
 * Reads only files held by the current foreground provider descendants. This deliberately fails closed on non-macOS
 * hosts, an unreadable process table, excessive process fan-out, or an `lsof` timeout/output limit.
 */
export async function detectForegroundAgentOpenFiles(
    shellPid: number,
    provider: AgentProvider,
): Promise<ProcessOpenFile[]> {
    if (process.platform !== 'darwin') return [];
    let processList: { stdout: string };
    try {
        processList = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,command='], {
            encoding: 'utf8',
            maxBuffer: PROCESS_QUERY_MAX_BUFFER_BYTES,
            timeout: PROCESS_QUERY_TIMEOUT_MS,
        });
    } catch {
        return [];
    }
    const pids = foregroundAgentProcessIdsFromProcessList(processList.stdout, shellPid, provider);
    if (!pids || pids.length === 0) return [];
    try {
        const result = await execFileAsync(
            '/usr/sbin/lsof',
            ['-nP', '-a', '-p', pids.join(','), '-Fpfan'],
            {
                encoding: 'utf8',
                maxBuffer: OPEN_FILE_QUERY_MAX_BUFFER_BYTES,
                timeout: OPEN_FILE_QUERY_TIMEOUT_MS,
            },
        );
        const currentProcessList = await execFileAsync(
            '/bin/ps',
            ['-axo', 'pid=,ppid=,pgid=,tpgid=,command='],
            {
                encoding: 'utf8',
                maxBuffer: PROCESS_QUERY_MAX_BUFFER_BYTES,
                timeout: PROCESS_QUERY_TIMEOUT_MS,
            },
        );
        const currentPids = foregroundAgentProcessIdsFromProcessList(
            currentProcessList.stdout,
            shellPid,
            provider,
        );
        if (
            !currentPids ||
            currentPids.length !== pids.length ||
            currentPids.some((pid, index) => pid !== pids[index])
        )
            return [];
        const allowedPids = new Set(pids);
        return openFilesFromLsofOutput(result.stdout).filter((file) => allowedPids.has(file.pid));
    } catch {
        return [];
    }
}
