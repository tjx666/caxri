import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import type { StateIsolation } from './case-lifecycle';
import { validatePlanFixtureDeclarations } from './plan-fixtures';
import { validateExistingReportDirectory } from './report-paths';
import { planItemSchema } from './report-plan-schema';

/**
 * Reads one case of a report's frozen plan for a guarded runner, together with the source commit its receipts bind to.
 */
export async function loadAcceptanceCasePlan(
    reportDirectory: string,
    caseId: string,
): Promise<{ commit: string; directory: string; item: z.infer<typeof planItemSchema> }> {
    const directory = await validateExistingReportDirectory(reportDirectory);
    const resultPath = join(directory, 'result.json');
    const raw: unknown = JSON.parse(await readFile(resultPath, 'utf8'));
    const { commit, plan } = z
        .object({
            commit: z.string().trim().min(1).optional(),
            plan: z.array(planItemSchema).min(1),
        })
        .parse(raw);
    // `init` accepts a report without `--commit`, but a runner cannot bind its receipts to an unfrozen source.
    if (!commit)
        throw new Error(
            `${resultPath} has no frozen source commit; initialize the round with \`report.ts init --commit "$(git rev-parse HEAD)"\``,
        );
    const item = plan.find(({ id }) => id === caseId);
    if (!item) throw new Error(`Acceptance case ${caseId} is not present in the frozen plan`);
    validatePlanFixtureDeclarations([item]);
    return { commit, directory, item };
}

/**
 * Rejects a launch whose profile reuse contradicts the case's frozen state isolation.
 */
export function validateAcceptanceCaseLaunch(
    stateIsolation: StateIsolation,
    input: { caseMode: 'isolated' | 'restart'; cleanupReusable: boolean; reuseUserData: boolean },
): { profileId?: string } {
    if (stateIsolation.mode === 'readonly_checkpoint') {
        throw new Error('Readonly checkpoint cases require a checkpoint-aware launch adapter');
    }
    if (stateIsolation.mode === 'isolated') {
        if (input.caseMode !== 'isolated' || input.reuseUserData || input.cleanupReusable) {
            throw new Error('An isolated Acceptance case cannot reuse a profile');
        }
        return {};
    }
    if (input.caseMode !== 'restart' || !input.reuseUserData) {
        throw new Error('A declared restart case must reuse its frozen profile');
    }
    return { profileId: stateIsolation.profileId };
}
