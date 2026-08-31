import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { acceptanceAgentFixtureIds } from './agent-fixtures';
import { errorCode, validateExistingReportDirectory, writeJsonAtomically } from './report-paths';

const agentFixtureLaunchSchema = z.object({
    cleanupCompleted: z.boolean(),
    completedAt: z.string().nullable(),
    id: z.string().min(1),
    startedAt: z.string(),
});

const agentFixtureReceiptSchema = z.object({
    caseId: z.string().min(1),
    fixtureId: z.enum(acceptanceAgentFixtureIds),
    launches: z.array(agentFixtureLaunchSchema).min(1),
    mode: z.literal('fake'),
    providers: z.tuple([z.literal('claude'), z.literal('codex')]),
    schemaVersion: z.literal(1),
});

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
            providers: ['claude', 'codex'],
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
