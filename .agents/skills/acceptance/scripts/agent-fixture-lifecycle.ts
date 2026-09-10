import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { acceptanceAgentFixtureIds } from './agent-fixtures';
import { LIFECYCLE_FORCED_COMPLETION_SOURCES } from './case-lifecycle';
import { errorCode, validateExistingReportDirectory, writeJsonAtomically } from './report-paths';

const agentFixtureLaunchSchema = z.object({
    cleanupCompleted: z.boolean(),
    completedAt: z.string().nullable(),
    /**
     * Present when the launcher completed this launch with the fixture root still on disk and `stop-electron.ts`
     * removed the owning profile afterwards; mirrors the lifecycle receipt's `deferredCleanup` marker.
     */
    deferredCleanup: z
        .object({ reason: z.string().min(1), source: z.enum(LIFECYCLE_FORCED_COMPLETION_SOURCES) })
        .optional(),
    id: z.string().min(1),
    startedAt: z.string(),
});

const fixtureProvidersSchema = z.union([
    z.tuple([z.literal('claude'), z.literal('codex')]),
    z.tuple([z.literal('grok')]),
]);
const agentFixtureReceiptSchema = z
    .object({
        caseId: z.string().min(1),
        fixtureId: z.enum(acceptanceAgentFixtureIds),
        launches: z.array(agentFixtureLaunchSchema).min(1),
        mode: z.literal('fake'),
        providers: fixtureProvidersSchema,
        schemaVersion: z.literal(1),
    })
    .refine(
        (receipt) =>
            receipt.fixtureId === 'grok-build-v1'
                ? receipt.providers.length === 1
                : receipt.providers.length === 2,
        { message: 'Agent fixture providers must match its fixed identity' },
    );

type AgentFixtureReceipt = z.infer<typeof agentFixtureReceiptSchema>;

function agentFixtureEvidencePath(caseId: string): string {
    return `assets/${encodeURIComponent(caseId)}-agent-fixture.json`;
}

async function readAgentFixtureReceipt(path: string): Promise<AgentFixtureReceipt> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('Acceptance Agent fixture receipt must be a direct regular file');
    }
    return agentFixtureReceiptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export async function beginAgentFixtureLifecycle(
    reportDirectory: string,
    input: { caseId: string; fixtureId: string },
    startedAt = new Date().toISOString(),
): Promise<string> {
    const directory = await validateExistingReportDirectory(reportDirectory);
    const fixtureId = z.enum(acceptanceAgentFixtureIds).parse(input.fixtureId);
    const path = join(directory, agentFixtureEvidencePath(input.caseId));
    let receipt: AgentFixtureReceipt;
    try {
        receipt = await readAgentFixtureReceipt(path);
        if (receipt.caseId !== input.caseId || receipt.fixtureId !== input.fixtureId) {
            throw new Error('Acceptance Agent fixture receipt does not match the frozen case');
        }
        if (receipt.launches.some(({ completedAt }) => completedAt === null)) {
            throw new Error('Previous Acceptance Agent fixture launch has not completed');
        }
    } catch (error: unknown) {
        if (errorCode(error) !== 'ENOENT') throw error;
        receipt = {
            caseId: input.caseId,
            fixtureId,
            launches: [],
            mode: 'fake',
            providers: fixtureId === 'grok-build-v1' ? ['grok'] : ['claude', 'codex'],
            schemaVersion: 1,
        };
    }
    const launchId = randomUUID();
    receipt.launches.push({
        cleanupCompleted: false,
        completedAt: null,
        id: launchId,
        startedAt,
    });
    await writeJsonAtomically(path, agentFixtureReceiptSchema.parse(receipt));
    return launchId;
}

export async function completeAgentFixtureLifecycle(
    reportDirectory: string,
    input: {
        caseId: string;
        cleanupCompleted: boolean;
        launchId: string;
        sharedProfile: boolean;
    },
    completedAt = new Date().toISOString(),
): Promise<void> {
    const directory = await validateExistingReportDirectory(reportDirectory);
    const path = join(directory, agentFixtureEvidencePath(input.caseId));
    const receipt = await readAgentFixtureReceipt(path);
    const launch = receipt.launches.find(({ id }) => id === input.launchId);
    if (!launch || launch.completedAt)
        throw new Error('Acceptance Agent fixture launch is not pending');
    /**
     * A restart case shares one fixture root, so its final profile cleanup covers every prior launch. An isolated retry
     * owns a fresh profile and must never retroactively claim that an earlier profile was cleaned.
     */
    if (input.cleanupCompleted && input.sharedProfile) {
        for (const item of receipt.launches) item.cleanupCompleted = true;
    } else {
        launch.cleanupCompleted = input.cleanupCompleted;
    }
    launch.completedAt = completedAt;
    await writeJsonAtomically(path, receipt);
}

/**
 * Records that the profile owning this fixture root was removed after the launcher had already completed the launch
 * honestly with `cleanupCompleted: false` (a detached Server generation still held the profile). The fixture root lives
 * inside the isolated profile, so the caller's verified profile removal covers it. A restart case shares one fixture
 * root across launches, so, exactly like {@link completeAgentFixtureLifecycle}, its verified cleanup covers every
 * earlier completed launch too. Returns `already_completed` when there is nothing to amend so a repeated stop stays
 * idempotent, and `pending` when the launch still belongs to a launcher that has not completed it.
 */
export async function recordDeferredAgentFixtureCleanup(
    reportDirectory: string,
    input: {
        caseId: string;
        launchId: string;
        sharedProfile: boolean;
        source: (typeof LIFECYCLE_FORCED_COMPLETION_SOURCES)[number];
    },
): Promise<'cleanup_recorded' | 'already_completed' | 'pending'> {
    const directory = await validateExistingReportDirectory(reportDirectory);
    const path = join(directory, agentFixtureEvidencePath(input.caseId));
    const receipt = await readAgentFixtureReceipt(path);
    const launch = receipt.launches.find(({ id }) => id === input.launchId);
    if (!launch) throw new Error('Acceptance Agent fixture launch is not recorded');
    if (!launch.completedAt) return 'pending';
    const covered = input.sharedProfile ? receipt.launches : [launch];
    const amended = covered.filter((item) => item.completedAt && !item.cleanupCompleted);
    if (amended.length === 0) return 'already_completed';
    for (const item of amended) {
        item.cleanupCompleted = true;
        item.deferredCleanup = {
            reason: `${input.source} verified the owning profile was removed after the launcher completed its receipt`,
            source: input.source,
        };
    }
    await writeJsonAtomically(path, agentFixtureReceiptSchema.parse(receipt));
    return 'cleanup_recorded';
}

export async function validateAgentFixtureEvidence(
    directory: string,
    input: {
        caseId: string;
        evidencePaths: string[];
        fixtureId: string | undefined;
    },
): Promise<void> {
    if (!input.fixtureId) return;
    const evidence = agentFixtureEvidencePath(input.caseId);
    if (!input.evidencePaths.includes(evidence)) {
        throw new Error(`Case ${input.caseId} must include its Agent fixture receipt`);
    }
    const receipt = await readAgentFixtureReceipt(join(directory, evidence));
    if (
        receipt.caseId !== input.caseId ||
        receipt.fixtureId !== input.fixtureId ||
        receipt.launches.some(
            ({ cleanupCompleted, completedAt }) => !cleanupCompleted || completedAt === null,
        )
    ) {
        throw new Error(
            `Case ${input.caseId} Agent fixture receipt does not match the frozen plan`,
        );
    }
}
