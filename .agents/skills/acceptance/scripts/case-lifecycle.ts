import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { errorCode, validateExistingReportDirectory, writeJsonAtomically } from './report-paths';
import { isAcceptanceProfileIdentityRemoved } from './runtime-state';

/**
 * Owns the per-case `assets/<case-id>-state-isolation.json` receipt: the frozen isolation contract, every launch's
 * ready/cleanup/completion state, and the recovery paths used when a launcher could not finish its own record.
 */
export const stateIsolationSchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('isolated') }),
    z.object({ checkpointId: z.string().min(1), mode: z.literal('readonly_checkpoint') }),
    z.object({
        cleanupOwner: z.literal('final_launch'),
        mode: z.literal('restart'),
        profileId: z.string().min(1),
    }),
]);
export type StateIsolation = z.infer<typeof stateIsolationSchema>;
const LIFECYCLE_FORCED_COMPLETION_SOURCES = ['stop-electron', 'report-repair'] as const;
/**
 * Present only when the launcher did not complete its own receipt: the stop adapter finished it after the launcher was
 * gone or force-killed, or an operator repaired it with an explicit reason. Its absence means the launcher completed
 * normally.
 */
const lifecycleForcedCompletionSchema = z.object({
    reason: z.string().min(1),
    source: z.enum(LIFECYCLE_FORCED_COMPLETION_SOURCES),
});
const lifecycleLaunchSchema = z.object({
    cleanupCompleted: z.boolean(),
    cleanupRequested: z.boolean(),
    completedAt: z.string().nullable(),
    /**
     * Present when the launcher completed its own receipt with the profile still present (a detached Server generation
     * kept it alive) and the stop adapter removed the profile afterwards. `cleanupCompleted` is then true, and this
     * field says who verified the removal so the receipt still distinguishes deferred cleanup from launcher cleanup.
     */
    deferredCleanup: lifecycleForcedCompletionSchema.optional(),
    forcedCompletion: lifecycleForcedCompletionSchema.optional(),
    id: z.string().min(1),
    profileIdentity: z.string().min(1),
    ready: z.boolean(),
    startedAt: z.string(),
});
export const caseLifecycleReceiptSchema = z.object({
    caseId: z.string().min(1),
    launches: z.array(lifecycleLaunchSchema).min(1),
    profileIdentity: z.string().min(1),
    schemaVersion: z.literal(1),
    stateIsolation: stateIsolationSchema,
});
type CaseLifecycleReceipt = z.infer<typeof caseLifecycleReceiptSchema>;
export type LifecycleForcedCompletion = z.infer<typeof lifecycleForcedCompletionSchema>;
export interface RepairCaseLifecycleInput {
    caseId: string;
    /**
     * Verifies an isolated profile identity is gone; injected so the repair stays testable without real profiles.
     */
    isProfileRemoved?: (profileIdentity: string) => Promise<boolean>;
    reason: string;
}
export interface RepairCaseLifecycleResult {
    path: string;
    repairedLaunchIds: string[];
}
export function lifecycleEvidencePath(caseId: string): string {
    return `assets/${encodeURIComponent(caseId)}-state-isolation.json`;
}

export async function beginCaseLifecycle(
    reportDirectory: string,
    input: { caseId: string; profileIdentity: string; stateIsolation: StateIsolation },
    startedAt = new Date().toISOString(),
): Promise<string> {
    const directory = await validateExistingReportDirectory(reportDirectory);
    const path = join(directory, lifecycleEvidencePath(input.caseId));
    let receipt: CaseLifecycleReceipt;
    try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
            throw new Error('Acceptance lifecycle receipt must be a direct regular file');
        }
        receipt = caseLifecycleReceiptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        if (
            receipt.caseId !== input.caseId ||
            JSON.stringify(receipt.stateIsolation) !== JSON.stringify(input.stateIsolation)
        ) {
            throw new Error('Acceptance lifecycle receipt does not match the frozen case profile');
        }
        if (receipt.launches.some(({ completedAt }) => completedAt === null)) {
            throw new Error('Previous Acceptance case launch has not completed');
        }
        if (input.stateIsolation.mode === 'isolated') {
            if (
                receipt.launches.some(
                    ({ cleanupCompleted, cleanupRequested }) =>
                        !cleanupRequested || !cleanupCompleted,
                )
            ) {
                throw new Error('An isolated Acceptance launch must clean up before retry');
            }
            if (
                receipt.launches.some(
                    ({ profileIdentity }) => profileIdentity === input.profileIdentity,
                )
            ) {
                throw new Error('An isolated Acceptance retry must use a fresh profile');
            }
            receipt.profileIdentity = input.profileIdentity;
        } else {
            if (receipt.profileIdentity !== input.profileIdentity) {
                throw new Error(
                    'Acceptance lifecycle receipt does not match the frozen case profile',
                );
            }
            if (receipt.launches.at(-1)?.cleanupCompleted) {
                throw new Error('Acceptance restart profile was already cleaned up');
            }
        }
    } catch (error: unknown) {
        if (errorCode(error) !== 'ENOENT') throw error;
        receipt = {
            caseId: input.caseId,
            launches: [],
            profileIdentity: input.profileIdentity,
            schemaVersion: 1,
            stateIsolation: input.stateIsolation,
        };
    }
    const launchId = randomUUID();
    receipt.launches.push({
        cleanupCompleted: false,
        cleanupRequested: false,
        completedAt: null,
        id: launchId,
        profileIdentity: input.profileIdentity,
        ready: false,
        startedAt,
    });
    await writeJsonAtomically(path, caseLifecycleReceiptSchema.parse(receipt));
    return launchId;
}

export async function markCaseLifecycleReady(
    reportDirectory: string,
    input: { caseId: string; launchId: string },
): Promise<void> {
    const directory = await validateExistingReportDirectory(reportDirectory);
    const path = join(directory, lifecycleEvidencePath(input.caseId));
    const receipt = caseLifecycleReceiptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    const launch = receipt.launches.find(({ id }) => id === input.launchId);
    if (!launch || launch.completedAt) throw new Error('Acceptance lifecycle launch is not active');
    launch.ready = true;
    await writeJsonAtomically(path, receipt);
}

export async function completeCaseLifecycle(
    reportDirectory: string,
    input: {
        caseId: string;
        cleanupCompleted: boolean;
        cleanupRequested: boolean;
        launchId: string;
    },
    completedAt = new Date().toISOString(),
): Promise<void> {
    const directory = await validateExistingReportDirectory(reportDirectory);
    const path = join(directory, lifecycleEvidencePath(input.caseId));
    const receipt = caseLifecycleReceiptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    const launch = receipt.launches.find(({ id }) => id === input.launchId);
    if (!launch || launch.completedAt)
        throw new Error('Acceptance lifecycle launch is not pending');
    launch.cleanupRequested = input.cleanupRequested;
    launch.cleanupCompleted = input.cleanupCompleted;
    launch.completedAt = completedAt;
    await writeJsonAtomically(path, receipt);
}

/**
 * Completes a launch on behalf of a launcher that could not, e.g. because the stop adapter had to force-kill it.
 * Returns `already_completed` when the launcher won the race so the adapter never overwrites a genuine receipt.
 *
 * One completed receipt is still amended: when the launcher honestly recorded `cleanupRequested` without
 * `cleanupCompleted` because a detached Server generation kept the profile in use, and the adapter has since verified
 * the profile is gone, the cleanup is recorded as completed with a `deferredCleanup` marker and `cleanup_recorded` is
 * returned. Without this, every isolated case whose Server Core outlived Electron failed `report.ts finalize` even
 * though the profile had been removed.
 */
export async function forceCompleteCaseLifecycle(
    reportDirectory: string,
    input: {
        caseId: string;
        cleanupCompleted: boolean;
        cleanupRequested: boolean;
        launchId: string;
    } & LifecycleForcedCompletion,
    completedAt = new Date().toISOString(),
): Promise<'completed' | 'already_completed' | 'cleanup_recorded'> {
    const directory = await validateExistingReportDirectory(reportDirectory);
    const path = join(directory, lifecycleEvidencePath(input.caseId));
    const receipt = caseLifecycleReceiptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    const launch = receipt.launches.find(({ id }) => id === input.launchId);
    if (!launch) throw new Error('Acceptance lifecycle launch is not recorded');
    if (launch.completedAt) {
        if (!input.cleanupCompleted || !launch.cleanupRequested || launch.cleanupCompleted)
            return 'already_completed';
        launch.cleanupCompleted = true;
        // The caller's reason describes the launcher outcome; the marker states what was actually verified here.
        launch.deferredCleanup = {
            reason: `${input.source} verified the profile was removed after the launcher completed its receipt`,
            source: input.source,
        };
        await writeJsonAtomically(path, caseLifecycleReceiptSchema.parse(receipt));
        return 'cleanup_recorded';
    }
    launch.cleanupRequested = input.cleanupRequested;
    launch.cleanupCompleted = input.cleanupCompleted;
    launch.completedAt = completedAt;
    launch.forcedCompletion = { reason: input.reason, source: input.source };
    await writeJsonAtomically(path, caseLifecycleReceiptSchema.parse(receipt));
    return 'completed';
}

/**
 * Recovers a receipt whose launch never completed without editing evidence by hand. An isolated launch is closed only
 * after its profile directory is verified gone, so the recorded cleanup stays true; a restart launch keeps its shared
 * profile and records no cleanup.
 */
export async function repairCaseLifecycle(
    reportDirectory: string,
    input: RepairCaseLifecycleInput,
    completedAt = new Date().toISOString(),
): Promise<RepairCaseLifecycleResult> {
    const directory = await validateExistingReportDirectory(reportDirectory);
    const path = join(directory, lifecycleEvidencePath(input.caseId));
    const reason = z.string().trim().min(1).parse(input.reason);
    const isProfileRemoved = input.isProfileRemoved ?? isAcceptanceProfileIdentityRemoved;
    const receipt = caseLifecycleReceiptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (receipt.caseId !== input.caseId) {
        throw new Error('Acceptance lifecycle receipt does not match the requested case');
    }
    const pendingLaunches = receipt.launches.filter(({ completedAt }) => completedAt === null);
    if (pendingLaunches.length === 0) {
        throw new Error('Acceptance lifecycle receipt has no pending launch to repair');
    }
    for (const launch of pendingLaunches) {
        const isIsolated = receipt.stateIsolation.mode === 'isolated';
        // eslint-disable-next-line no-await-in-loop -- each pending launch verifies its own profile before it is closed
        if (isIsolated && !(await isProfileRemoved(launch.profileIdentity))) {
            throw new Error(
                `Acceptance profile ${launch.profileIdentity} still exists; stop the instance before repairing its receipt`,
            );
        }
        launch.cleanupRequested = isIsolated;
        launch.cleanupCompleted = isIsolated;
        launch.completedAt = completedAt;
        launch.forcedCompletion = { reason, source: 'report-repair' };
    }
    await writeJsonAtomically(path, caseLifecycleReceiptSchema.parse(receipt));
    return { path, repairedLaunchIds: pendingLaunches.map(({ id }) => id) };
}
