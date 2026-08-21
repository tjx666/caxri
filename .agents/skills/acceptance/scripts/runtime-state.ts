import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import { execFileAsync } from '../../../../src/shared/node/exec';

const ACCEPTANCE_USER_DATA_PREFIX = 'caxri-acceptance-user-';
const PROCESS_PROBE_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const PROCESS_PROBE_TIMEOUT_MS = 2_000;
const acceptanceCaseModeSchema = z.enum(['isolated', 'restart']);
const acceptanceCaseSchema = z.object({
    id: z.string().min(1),
    mode: acceptanceCaseModeSchema,
});
const ownedProcessRoleSchema = z.enum(['host', 'runtime']);
const ownedProcessSchema = z.object({
    identity: z.string().min(1),
    pid: z.number().int().positive(),
    role: ownedProcessRoleSchema,
});

export const runtimeStateSchema = z.object({
    acceptanceCase: acceptanceCaseSchema.nullable().optional(),
    cdpUrl: z.string(),
    electronIdentity: z.string().min(1).nullable(),
    electronPid: z.number().int().positive().nullable(),
    launcherIdentity: z.string().min(1),
    launcherPid: z.number().int().positive(),
    ownedProcesses: z.array(ownedProcessSchema),
    ownedUserData: z.boolean(),
    port: z.number().int().min(1024).max(65_535),
    projectRoot: z.string().min(1),
    startedAt: z.string(),
    testRootPath: z.string(),
    testRootPaths: z.array(z.string()).min(1).optional(),
    userDataDir: z.string(),
});

export type RuntimeState = z.infer<typeof runtimeStateSchema>;
export type OwnedProcess = z.infer<typeof ownedProcessSchema>;

export interface ProcessDiscoveryDependencies {
    canonicalPath: (path: string) => Promise<string>;
    getProcessCommand: (pid: number) => Promise<string | null>;
    getProcessIdentity: typeof getProcessIdentity;
    inspectPathOwner: (path: string) => Promise<number | undefined>;
    listChildProcesses: (parentPid: number) => Promise<Array<{ command: string; pid: number }>>;
}

interface PrepareUserDataOptions {
    caseId?: string;
    caseMode?: z.infer<typeof acceptanceCaseModeSchema>;
    cleanupReusable: boolean;
    profileId?: string;
    reuseUserDataDir?: string;
}

function normalizeCaseId(caseId: string = 'unscoped'): string {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(caseId)) {
        throw new Error('Acceptance case id must use lowercase letters, digits, and hyphens');
    }
    return caseId;
}

function profilePrefix(caseId: string): string {
    return `${ACCEPTANCE_USER_DATA_PREFIX}${caseId.length}-${caseId}-`;
}

async function resolveSafeAcceptanceUserDataDirectory(
    path: string,
    expectedCaseId?: string,
): Promise<string> {
    const [temporaryRoot, candidate] = await Promise.all([realpath(tmpdir()), realpath(path)]);
    const relativeCandidate = relative(temporaryRoot, candidate);
    const candidateStat = await stat(candidate);
    if (
        !relativeCandidate ||
        relativeCandidate === '..' ||
        !candidateStat.isDirectory() ||
        relativeCandidate.startsWith(`..${sep}`) ||
        isAbsolute(relativeCandidate) ||
        !basename(candidate).startsWith(ACCEPTANCE_USER_DATA_PREFIX) ||
        (expectedCaseId && !basename(candidate).startsWith(profilePrefix(expectedCaseId)))
    ) {
        throw new Error(
            `Reusable Acceptance user data must be a ${ACCEPTANCE_USER_DATA_PREFIX}* directory beneath ${temporaryRoot}`,
        );
    }
    return candidate;
}

/**
 * Creates the default disposable profile or validates a caller-owned profile used across a bounded restart check.
 * Reusable profiles must already exist beneath the OS temp directory and keep the Acceptance prefix so an arbitrary
 * developer profile can never enter the cleanup path.
 */
export async function prepareAcceptanceUserData({
    caseId,
    caseMode = 'isolated',
    cleanupReusable,
    profileId,
    reuseUserDataDir,
}: PrepareUserDataOptions): Promise<
    Pick<RuntimeState, 'acceptanceCase' | 'ownedUserData' | 'userDataDir'>
> {
    const normalizedCaseId = normalizeCaseId(caseId);
    const normalizedCaseMode = acceptanceCaseModeSchema.parse(caseMode);
    if (!reuseUserDataDir) {
        if (cleanupReusable)
            throw new Error('--cleanup-reused-user-data requires --reuse-user-data');
        if (normalizedCaseMode === 'restart') {
            throw new Error('A restart Acceptance case requires --reuse-user-data');
        }
        return {
            acceptanceCase: { id: normalizedCaseId, mode: 'isolated' },
            ownedUserData: true,
            userDataDir: await mkdtemp(join(tmpdir(), profilePrefix(normalizedCaseId))),
        };
    }

    if (!caseId || normalizedCaseMode !== 'restart') {
        throw new Error('Reusable Acceptance user data requires a named restart case');
    }
    const candidate = await resolveSafeAcceptanceUserDataDirectory(
        reuseUserDataDir,
        normalizeCaseId(profileId ?? normalizedCaseId),
    );
    return {
        acceptanceCase: { id: normalizedCaseId, mode: 'restart' },
        ownedUserData: cleanupReusable,
        userDataDir: candidate,
    };
}

export function errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' || typeof error.code === 'number'
        ? String(error.code)
        : undefined;
}

export function isAlive(pid: number | null | undefined): boolean {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        if (errorCode(error) === 'EPERM') return false;
        if (errorCode(error) === 'ESRCH') return false;
        throw error;
    }
}

/**
 * Combines immutable process start time and command text so a recycled PID cannot be mistaken for the Acceptance
 * launcher that wrote runtime.json.
 */
export async function getProcessIdentity(pid: number): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync(
            'ps',
            ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='],
            {
                maxBuffer: PROCESS_PROBE_MAX_BUFFER_BYTES,
                timeout: PROCESS_PROBE_TIMEOUT_MS,
            },
        );
        return stdout.trim() || null;
    } catch (error: unknown) {
        if (errorCode(error) === '1' || errorCode(error) === 'ENOENT') return null;
        throw error;
    }
}

async function getProcessCommand(pid: number): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
            maxBuffer: PROCESS_PROBE_MAX_BUFFER_BYTES,
            timeout: PROCESS_PROBE_TIMEOUT_MS,
        });
        return stdout.trim() || null;
    } catch (error: unknown) {
        if (errorCode(error) === '1' || errorCode(error) === 'ENOENT') return null;
        throw error;
    }
}

async function inspectPathOwner(path: string): Promise<number | undefined> {
    try {
        const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-F', 'p', '--', path], {
            maxBuffer: PROCESS_PROBE_MAX_BUFFER_BYTES,
            timeout: PROCESS_PROBE_TIMEOUT_MS,
        });
        const processIds = new Set(
            stdout
                .split(/\r?\n/u)
                .filter((line) => /^p\d+$/u.test(line))
                .map((line) => Number(line.slice(1))),
        );
        if (processIds.size > 1)
            throw new Error('Multiple processes own the Acceptance Host profile lock');
        return processIds.values().next().value;
    } catch (error: unknown) {
        if (errorCode(error) === '1' || errorCode(error) === 'ENOENT') return undefined;
        throw error;
    }
}

async function listChildProcesses(
    parentPid: number,
): Promise<Array<{ command: string; pid: number }>> {
    const { stdout } = await execFileAsync(
        'ps',
        ['-ww', '-axo', 'pid=', '-o', 'ppid=', '-o', 'command='],
        {
            maxBuffer: PROCESS_PROBE_MAX_BUFFER_BYTES,
            timeout: PROCESS_PROBE_TIMEOUT_MS,
        },
    );
    return stdout.split(/\r?\n/u).flatMap((line) => {
        const trimmed = line.trimStart();
        const match = /^(\d+)\s+(\d+)\s+/u.exec(trimmed);
        if (!match || Number(match[2]) !== parentPid) return [];
        return [{ command: trimmed.slice(match[0].length), pid: Number(match[1]) }];
    });
}

const defaultProcessDiscoveryDependencies: ProcessDiscoveryDependencies = {
    canonicalPath: realpath,
    getProcessCommand,
    getProcessIdentity,
    inspectPathOwner,
    listChildProcesses,
};

function isCommandForEntry(command: string, entryPath: string): boolean {
    return command === entryPath || command.endsWith(` ${entryPath}`);
}

/**
 * Binds cleanup to the selected profile's live kernel lock owner and then to the exact worktree's Host/Runtime
 * entrypoints. PID metadata alone is never enough, and Runtime ownership derives from the verified Host parent before
 * either process is signaled.
 */
export async function discoverOwnedProcesses(
    runtime: Pick<RuntimeState, 'projectRoot' | 'userDataDir'>,
    expectedProjectRoot: string,
    dependencies: ProcessDiscoveryDependencies = defaultProcessDiscoveryDependencies,
): Promise<OwnedProcess[]> {
    const [recordedProjectRoot, currentProjectRoot] = await Promise.all([
        dependencies.canonicalPath(runtime.projectRoot),
        dependencies.canonicalPath(expectedProjectRoot),
    ]);
    if (recordedProjectRoot !== currentProjectRoot) {
        throw new Error('Acceptance runtime belongs to a different worktree');
    }

    let userDataDirectory: string;
    try {
        userDataDirectory = await dependencies.canonicalPath(runtime.userDataDir);
    } catch (error: unknown) {
        if (errorCode(error) === 'ENOENT') return [];
        throw error;
    }
    const hostPid = await dependencies.inspectPathOwner(
        join(userDataDirectory, 'host', 'owner.lock'),
    );
    if (!hostPid) return [];

    const hostEntryPath = join(recordedProjectRoot, 'out', 'main', 'host.js');
    const hostCommand = await dependencies.getProcessCommand(hostPid);
    if (!hostCommand || !isCommandForEntry(hostCommand, hostEntryPath)) {
        throw new Error('Acceptance profile lock owner is outside the recorded worktree');
    }
    const hostIdentity = await dependencies.getProcessIdentity(hostPid);
    if (!hostIdentity) return [];

    const runtimeEntryPath = join(recordedProjectRoot, 'out', 'main', 'runtime.js');
    const runtimeProcesses = await Promise.all(
        (await dependencies.listChildProcesses(hostPid))
            .filter(({ command }) => isCommandForEntry(command, runtimeEntryPath))
            .map(async ({ pid }) => {
                const identity = await dependencies.getProcessIdentity(pid);
                return identity
                    ? ownedProcessSchema.parse({ identity, pid, role: 'runtime' })
                    : null;
            }),
    );
    return [
        ownedProcessSchema.parse({ identity: hostIdentity, pid: hostPid, role: 'host' }),
        ...runtimeProcesses.filter((item): item is OwnedProcess => item !== null),
    ];
}

export async function isOwnedProcess(
    ownedProcess: Pick<OwnedProcess, 'identity' | 'pid'>,
): Promise<boolean> {
    return (await getProcessIdentity(ownedProcess.pid)) === ownedProcess.identity;
}

export async function isOwnedLauncher(
    runtime: Pick<RuntimeState, 'launcherIdentity' | 'launcherPid'>,
): Promise<boolean> {
    return (await getProcessIdentity(runtime.launcherPid)) === runtime.launcherIdentity;
}

/**
 * An isolated Acceptance instance remains owned while either supervised process is alive.
 */
export async function isOwnedRuntime(
    runtime: Pick<
        RuntimeState,
        'electronIdentity' | 'electronPid' | 'launcherIdentity' | 'launcherPid'
    >,
): Promise<boolean> {
    if (await isOwnedLauncher(runtime)) return true;
    return Boolean(
        runtime.electronPid &&
        runtime.electronIdentity &&
        (await getProcessIdentity(runtime.electronPid)) === runtime.electronIdentity,
    );
}

export async function removeOwnedUserData(
    runtime: Pick<RuntimeState, 'ownedUserData' | 'userDataDir'>,
): Promise<void> {
    if (!runtime.ownedUserData) return;
    let safePath: string | undefined;
    try {
        safePath = await resolveSafeAcceptanceUserDataDirectory(runtime.userDataDir);
    } catch {
        // Not a safe, owned Acceptance profile directory; skip removal instead of throwing.
    }
    if (safePath) await rm(safePath, { force: true, recursive: true });
}
