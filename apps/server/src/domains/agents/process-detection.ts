import { readdir, readFile, readlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import process from 'node:process';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';

const PROCESS_QUERY_TIMEOUT_MS = 2_000;
const PROCESS_QUERY_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const OPEN_FILE_QUERY_TIMEOUT_MS = 1_000;
const OPEN_FILE_QUERY_MAX_BUFFER_BYTES = 512 * 1024;
const MAX_FOREGROUND_AGENT_PROCESSES = 64;
/**
 * Bound on the provider processes one machine-wide open-file probe inspects. More than this is not a plausible count of
 * interactive Agent CLIs, so the probe reports `too_many_processes` instead of paying for an unbounded `lsof`.
 */
const MAX_MACHINE_AGENT_PROCESSES = 64;
const MACHINE_OPEN_FILE_QUERY_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
/**
 * Per-process bound on `/proc/<pid>/fd` entries read on Linux, mirroring the `lsof` output cap on macOS.
 */
const MAX_PROC_FILE_DESCRIPTORS = 4_096;

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
 * Every process on the machine whose image belongs to `provider`, regardless of Terminal or process group. Used where
 * the question is "does any process of this provider hold a file", not "which Agent runs in this Terminal".
 */
export function agentProcessIdsFromProcessList(output: string, provider: AgentProvider): number[] {
    return parseProcessList(output)
        .filter((entry) => entry.pid !== process.pid && commandProvider(entry.command) === provider)
        .map((entry) => entry.pid);
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
 * Linux equivalent of `lsof -Fpfan`: each `/proc/<pid>/fd` link names an open file, and the matching `fdinfo` entry
 * carries the open flags whose low two bits are the access mode. Only paths and modes are read, never file contents.
 * Non-file descriptors (`socket:[...]`, `pipe:[...]`, `anon_inode:...`) are skipped, as are descriptors that close
 * between the directory read and the link read.
 */
export async function openFilesFromProcFileSystem(
    pids: readonly number[],
    procRoot = '/proc',
): Promise<ProcessOpenFile[]> {
    const perProcess = await Promise.all(
        pids.map(async (pid) => {
            const directory = join(procRoot, String(pid));
            let descriptors: string[];
            try {
                descriptors = (await readdir(join(directory, 'fd'))).slice(
                    0,
                    MAX_PROC_FILE_DESCRIPTORS,
                );
            } catch {
                return [];
            }
            const files = await Promise.all(
                descriptors.map(async (descriptor): Promise<ProcessOpenFile | undefined> => {
                    try {
                        const path = await readlink(join(directory, 'fd', descriptor));
                        if (!path.startsWith('/')) return undefined;
                        const info = await readFile(join(directory, 'fdinfo', descriptor), 'utf8');
                        const flags = /^flags:\s*([0-7]+)$/m.exec(info)?.[1];
                        if (flags === undefined) return undefined;
                        const mode = Number.parseInt(flags, 8) & 0o3;
                        return { access: mode === 0 ? 'r' : mode === 1 ? 'w' : 'u', path, pid };
                    } catch {
                        return undefined;
                    }
                }),
            );
            return files.filter((file): file is ProcessOpenFile => file !== undefined);
        }),
    );
    return perProcess.flat();
}

async function readOpenFiles(pids: readonly number[]): Promise<ProcessOpenFile[]> {
    if (process.platform === 'linux') return openFilesFromProcFileSystem(pids);
    const result = await execFileAsync(
        '/usr/sbin/lsof',
        ['-nP', '-a', '-p', pids.join(','), '-Fpfan'],
        {
            encoding: 'utf8',
            maxBuffer: OPEN_FILE_QUERY_MAX_BUFFER_BYTES,
            timeout: OPEN_FILE_QUERY_TIMEOUT_MS,
        },
    );
    return openFilesFromLsofOutput(result.stdout);
}

/**
 * Reads only files held by the current foreground provider descendants: `lsof` on macOS, `/proc` on Linux. This
 * deliberately fails closed on other hosts, an unreadable process table, excessive process fan-out, or an open-file
 * query timeout/output limit.
 */
export async function detectForegroundAgentOpenFiles(
    shellPid: number,
    provider: AgentProvider,
): Promise<ProcessOpenFile[]> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return [];
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
        const openFiles = await readOpenFiles(pids);
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
        return openFiles.filter((file) => allowedPids.has(file.pid));
    } catch {
        return [];
    }
}

/**
 * Closed reasons a machine-wide open-file probe could not produce an answer. Callers log only this enum.
 */
export type AgentOpenFilesProbeFailure =
    | 'unsupported_platform'
    | 'process_list_failed'
    | 'too_many_processes'
    | 'open_file_query_failed';

export type AgentOpenFilesProbe =
    { ok: true; files: ProcessOpenFile[] } | { ok: false; reason: AgentOpenFilesProbeFailure };

/**
 * `lsof` exits 1 when one of the listed PIDs exited between `ps` and `lsof`, yet still prints every other process's
 * files. Only that shape is accepted as a partial answer; a timeout, a kill, or an output-limit overflow is a failure.
 */
function partialLsofOutput(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    const { code, killed, stdout } = error as {
        code?: unknown;
        killed?: unknown;
        stdout?: unknown;
    };
    return code === 1 && killed !== true && typeof stdout === 'string' ? stdout : undefined;
}

/**
 * Lists the files every running `provider` process on this machine holds open: `lsof` on macOS, `/proc` on Linux.
 * Unlike {@link detectForegroundAgentOpenFiles} this is not scoped to one Terminal, so it also sees an Agent running in
 * another terminal application. Only paths and access modes are read, never contents; neither is logged here.
 */
export async function detectAgentOpenFiles(provider: AgentProvider): Promise<AgentOpenFilesProbe> {
    if (process.platform !== 'darwin' && process.platform !== 'linux')
        return { ok: false, reason: 'unsupported_platform' };
    let processList: { stdout: string };
    try {
        processList = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,command='], {
            encoding: 'utf8',
            maxBuffer: PROCESS_QUERY_MAX_BUFFER_BYTES,
            timeout: PROCESS_QUERY_TIMEOUT_MS,
        });
    } catch {
        return { ok: false, reason: 'process_list_failed' };
    }
    const pids = agentProcessIdsFromProcessList(processList.stdout, provider);
    if (pids.length === 0) return { ok: true, files: [] };
    if (pids.length > MAX_MACHINE_AGENT_PROCESSES)
        return { ok: false, reason: 'too_many_processes' };
    if (process.platform === 'linux')
        return { ok: true, files: await openFilesFromProcFileSystem(pids) };
    let output: string;
    try {
        output = (
            await execFileAsync('/usr/sbin/lsof', ['-nP', '-a', '-p', pids.join(','), '-Fpfan'], {
                encoding: 'utf8',
                maxBuffer: MACHINE_OPEN_FILE_QUERY_MAX_BUFFER_BYTES,
                timeout: OPEN_FILE_QUERY_TIMEOUT_MS,
            })
        ).stdout;
    } catch (error) {
        const partial = partialLsofOutput(error);
        if (partial === undefined) return { ok: false, reason: 'open_file_query_failed' };
        output = partial;
    }
    const allowed = new Set(pids);
    return {
        ok: true,
        files: openFilesFromLsofOutput(output).filter((file) => allowed.has(file.pid)),
    };
}
