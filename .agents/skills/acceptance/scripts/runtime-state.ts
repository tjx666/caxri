import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { z } from 'zod';

const execFileAsync = promisify(execFile);
const ACCEPTANCE_USER_DATA_PREFIX = 'caxri-acceptance-user-';
const acceptanceCaseModeSchema = z.enum(['isolated', 'restart']);
const acceptanceCaseSchema = z.object({
    id: z.string().min(1),
    mode: acceptanceCaseModeSchema,
});

export const runtimeStateSchema = z.object({
    acceptanceCase: acceptanceCaseSchema.nullable().optional(),
    cdpUrl: z.string(),
    electronIdentity: z.string().min(1).nullable(),
    electronPid: z.number().int().positive().nullable(),
    launcherIdentity: z.string().min(1),
    launcherPid: z.number().int().positive(),
    ownedUserData: z.boolean(),
    port: z.number().int().min(1024).max(65_535),
    startedAt: z.string(),
    testRootPath: z.string(),
    testRootPaths: z.array(z.string()).min(1).optional(),
    userDataDir: z.string(),
});

export type RuntimeState = z.infer<typeof runtimeStateSchema>;

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
 * Creates the default disposable profile or validates a caller-owned profile used across a
 * bounded restart check. Reusable profiles must already exist beneath the OS temp directory and
 * keep the Acceptance prefix so an arbitrary developer profile can never enter the cleanup path.
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
    return typeof error.code === 'string' ? error.code : undefined;
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
 * Combines immutable process start time and command text so a recycled PID
 * cannot be mistaken for the Acceptance launcher that wrote runtime.json.
 */
export async function getProcessIdentity(pid: number): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync('ps', [
            '-ww',
            '-p',
            String(pid),
            '-o',
            'lstart=',
            '-o',
            'command=',
        ]);
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

export async function isOwnedLauncher(
    runtime: Pick<RuntimeState, 'launcherIdentity' | 'launcherPid'>,
): Promise<boolean> {
    return (await getProcessIdentity(runtime.launcherPid)) === runtime.launcherIdentity;
}

/**
An isolated Acceptance instance remains owned while either supervised process is alive.
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
