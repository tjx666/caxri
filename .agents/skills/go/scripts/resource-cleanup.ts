import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import { listWorktreeStatus } from '../../switch-worktree/scripts/worktree';
import { captureCommand } from './command-runner';
import type { GoState } from './state-model';

export const resourceCleanupKindSchema = z.enum([
    'acceptance_runtime',
    'desktop_lease',
    'development_instance',
    'temporary_file',
    'validation_process_group',
    'worktree_process',
]);

export const resourceCleanupSchema = z
    .object({
        auditedAt: z.iso.datetime(),
        recovered: z.array(resourceCleanupKindSchema),
        runId: z.string().min(1),
        status: z.enum(['clean', 'recovered']),
        worktreePath: z.string().min(1),
    })
    .refine(
        ({ recovered, status }) =>
            (status === 'clean' && recovered.length === 0) ||
            (status === 'recovered' && recovered.length > 0),
        'Resource cleanup status must match its recovered categories',
    );

export type ResourceCleanupKind = z.infer<typeof resourceCleanupKindSchema>;
export type ResourceCleanupReceipt = z.infer<typeof resourceCleanupSchema>;

export interface ProcessSnapshot {
    command: string;
    cwd?: string;
    name: string;
    pid: number;
    ppid: number;
}

export interface WorktreeProcessFinding {
    name: string;
    pid: number;
}

export interface ResourceAuditDependencies {
    hasAcceptanceRuntime: (worktreePath: string) => Promise<boolean>;
    inspectRunTemporaryFiles: (runDirectory: string) => Promise<string[]>;
    inspectWorktreeProcesses: (worktreePath: string) => Promise<WorktreeProcessFinding[]>;
    inspectWorktreeStatus: (worktreePath: string) => Promise<{
        desktopLease: 'active' | 'active-other' | 'free' | 'stale' | 'stale-other';
        devProcess: 'active' | 'none' | 'stale';
    }>;
}

function isPathInside(parent: string, candidate: string): boolean {
    const nested = relative(resolve(parent), resolve(candidate));
    return (
        nested === '' || (!nested.startsWith(`..${sep}`) && nested !== '..' && !isAbsolute(nested))
    );
}

function ancestorPids(processes: ProcessSnapshot[], currentPid: number): Set<number> {
    const parents = new Map(processes.map(({ pid, ppid }) => [pid, ppid]));
    const ancestors = new Set<number>();
    let candidate: number | undefined = currentPid;
    while (candidate && !ancestors.has(candidate)) {
        ancestors.add(candidate);
        candidate = parents.get(candidate);
    }
    return ancestors;
}

/**
 * Finds only process candidates tied to the dedicated worktree. The returned evidence intentionally omits command
 * arguments because test commands, prompts, and credentials must never enter the Go ledger or final report.
 */
export function findRelatedWorktreeProcesses(
    processes: ProcessSnapshot[],
    worktreePath: string,
    currentPid = process.pid,
): WorktreeProcessFinding[] {
    const canonicalWorktree = resolve(worktreePath);
    const ignored = ancestorPids(processes, currentPid);
    return processes
        .filter(({ command, cwd, pid }) => {
            if (ignored.has(pid)) return false;
            const isCwdMatches = cwd ? isPathInside(canonicalWorktree, cwd) : false;
            const commandMatches =
                command.includes(`${canonicalWorktree}${sep}`) ||
                command.endsWith(canonicalWorktree);
            return isCwdMatches || commandMatches;
        })
        .map(({ name, pid }) => ({ name: basename(name) || 'unknown', pid }))
        .toSorted((left, right) => left.pid - right.pid);
}

function parseProcessTable(output: string): ProcessSnapshot[] {
    const processes: ProcessSnapshot[] = [];
    for (const line of output.split('\n')) {
        const [pidSource, ppidSource, name = 'unknown', ...commandParts] = line
            .trim()
            .split(/\s+/u);
        const pid = Number(pidSource);
        const ppid = Number(ppidSource);
        if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
        processes.push({ command: commandParts.join(' '), name, pid, ppid });
    }
    return processes;
}

function parseWorkingDirectories(output: string): Map<number, string> {
    const workingDirectories = new Map<number, string>();
    let pid: number | undefined;
    let isCwd = false;
    for (const line of output.split('\n')) {
        const prefix = line[0];
        const value = line.slice(1);
        if (prefix === 'p') {
            const candidate = Number(value);
            pid = Number.isSafeInteger(candidate) ? candidate : undefined;
            isCwd = false;
        } else if (prefix === 'f') {
            isCwd = value === 'cwd';
        } else if (prefix === 'n' && pid !== undefined && isCwd) {
            workingDirectories.set(pid, value);
            isCwd = false;
        }
    }
    return workingDirectories;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        return !(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ESRCH'
        );
    }
}

async function inspectWorktreeProcesses(worktreePath: string): Promise<WorktreeProcessFinding[]> {
    const canonicalWorktree = await realpath(worktreePath);
    const [processOutput, cwdOutput] = await Promise.all([
        captureCommand('ps', ['-axo', 'pid=,ppid=,comm=,command='], {
            cwd: canonicalWorktree,
            maxOutputBytes: 16 * 1024 * 1024,
            timeoutMs: 10_000,
        }),
        captureCommand('lsof', ['-n', '-P', '-a', '-d', 'cwd', '-Fpcn'], {
            cwd: canonicalWorktree,
            maxOutputBytes: 16 * 1024 * 1024,
            timeoutMs: 10_000,
        }),
    ]);
    const workingDirectories = parseWorkingDirectories(cwdOutput);
    const processes = parseProcessTable(processOutput).map((snapshot) => ({
        ...snapshot,
        cwd: workingDirectories.get(snapshot.pid),
    }));
    return findRelatedWorktreeProcesses(
        processes.filter(({ pid }) => isProcessAlive(pid)),
        canonicalWorktree,
    );
}

async function hasAcceptanceRuntime(worktreePath: string): Promise<boolean> {
    try {
        await lstat(join(worktreePath, '.records', 'acceptance', 'runtime.json'));
        return true;
    } catch (error: unknown) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
        ) {
            return false;
        }
        throw error;
    }
}

async function inspectRunTemporaryFiles(runDirectory: string): Promise<string[]> {
    const findings: string[] = [];
    const visit = async (directory: string): Promise<void> => {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                // eslint-disable-next-line no-await-in-loop -- bounded Go run tree inspection avoids symlink traversal
                await visit(path);
            } else if (entry.isFile() && entry.name.endsWith('.tmp')) {
                findings.push(relative(runDirectory, path));
            }
        }
    };
    await visit(runDirectory);
    return findings.toSorted((left, right) => left.localeCompare(right));
}

async function inspectWorktreeStatus(worktreePath: string) {
    const canonicalWorktree = await realpath(worktreePath);
    const status = (await listWorktreeStatus(canonicalWorktree)).find(
        ({ path }) => resolve(path) === resolve(canonicalWorktree),
    );
    if (!status) throw new Error('Recorded Go worktree is not registered with Git');
    return { desktopLease: status.desktopLease, devProcess: status.devProcess };
}

const DEFAULT_DEPENDENCIES: ResourceAuditDependencies = {
    hasAcceptanceRuntime,
    inspectRunTemporaryFiles,
    inspectWorktreeProcesses,
    inspectWorktreeStatus,
};

function formatProcessFinding({ name, pid }: WorktreeProcessFinding): string {
    return `worktree_process(pid=${pid},name=${name})`;
}

export async function auditGoResources(
    state: GoState,
    runDirectory: string,
    recoveredInput: ResourceCleanupKind[],
    dependencies: ResourceAuditDependencies = DEFAULT_DEPENDENCIES,
    auditedAt = new Date().toISOString(),
): Promise<ResourceCleanupReceipt> {
    if (state.phase !== 'finalization' || !state.finalization?.deliveredAt) {
        throw new Error('Resource cleanup audit requires delivered finalization');
    }
    if (!state.worktree)
        throw new Error('Resource cleanup audit requires the recorded Go worktree');
    if (state.mutationLease) {
        throw new Error('Resource cleanup audit cannot run while a mutation lease is active');
    }
    if (state.validations.some(({ result }) => result === 'pending')) {
        throw new Error('Resource cleanup audit cannot run while a validation process is pending');
    }

    const [acceptanceRuntime, temporaryFiles, processes, worktreeStatus] = await Promise.all([
        dependencies.hasAcceptanceRuntime(state.worktree.path),
        dependencies.inspectRunTemporaryFiles(runDirectory),
        dependencies.inspectWorktreeProcesses(state.worktree.path),
        dependencies.inspectWorktreeStatus(state.worktree.path),
    ]);
    const findings: string[] = [];
    if (acceptanceRuntime) findings.push('acceptance_runtime');
    if (worktreeStatus.desktopLease === 'active' || worktreeStatus.desktopLease === 'stale') {
        findings.push('desktop_lease');
    }
    if (worktreeStatus.devProcess !== 'none') findings.push('development_instance');
    if (temporaryFiles.length > 0) findings.push('temporary_file');
    findings.push(...processes.map(formatProcessFinding));
    if (findings.length > 0) {
        throw new Error(
            `Resource cleanup audit found current Go resources: ${findings.join(', ')}`,
        );
    }

    const recovered = [
        ...new Set(recoveredInput.map((kind) => resourceCleanupKindSchema.parse(kind))),
    ].toSorted((left, right) => left.localeCompare(right));
    const receipt = resourceCleanupSchema.parse({
        auditedAt,
        recovered,
        runId: state.runId,
        status: recovered.length > 0 ? 'recovered' : 'clean',
        worktreePath: state.worktree.path,
    });
    state.resourceCleanup = receipt;
    return receipt;
}

export function assertResourceCleanupComplete(
    state: Pick<
        GoState,
        'finalization' | 'mutationLease' | 'resourceCleanup' | 'runId' | 'validations' | 'worktree'
    >,
): void {
    const receipt = state.resourceCleanup;
    if (!receipt) throw new Error('Completion requires the resource cleanup audit');
    if (
        !state.worktree ||
        receipt.runId !== state.runId ||
        receipt.worktreePath !== state.worktree.path
    ) {
        throw new Error('Resource cleanup audit does not belong to this Go run and worktree');
    }
    const deliveredAt = Date.parse(state.finalization?.deliveredAt ?? '');
    if (!Number.isFinite(deliveredAt) || Date.parse(receipt.auditedAt) < deliveredAt) {
        throw new Error('Resource cleanup audit must postdate finalization delivery');
    }
    if (state.mutationLease || state.validations.some(({ result }) => result === 'pending')) {
        throw new Error('Completion requires no active Go process or mutation lease');
    }
}
