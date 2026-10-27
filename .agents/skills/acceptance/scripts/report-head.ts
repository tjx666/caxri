import { z } from 'zod';

import { validateHumanText } from './validate-report';

export interface RebindReportHeadInput {
    /**
     * Explicit `--allow-finalized`. Publication is recorded remotely, not in `result.json`, so this command cannot see
     * it; the flag makes the caller state that this round has not been ingested, and keeps an already-published round
     * from being moved by an unaware caller.
     */
    allowFinalized?: boolean;
    /**
     * Every repository path that differs between `fromCommit` and `commit`, resolved from git by the caller. A
     * finalized round is rebound only when this proves the delta cannot change what the product does; a free-text
     * `reason` alone is not evidence.
     */
    changedPaths?: readonly string[];
    commit: string;
    createdAt?: string;
    directory: string;
    entry: string;
    fromCommit: string;
    reason: string;
}

/**
 * The only tree a delivery head may move through after evidence was captured. `.agents/` holds the contributor skills
 * and the Acceptance adapter itself; nothing under it is shipped to a user or reachable from the running app, so the
 * captured product behavior still belongs to the new head.
 */
const NON_PRODUCT_REBIND_PREFIX = '.agents/';

const reportHeadRebindSchema = z.object({
    fromCommit: z.string().min(1),
    reason: z.string().min(1),
    reboundAt: z.string().min(1),
    toCommit: z.string().min(1),
});

const reportHeadSchema = z.looseObject({
    commit: z.string().min(1),
    createdAt: z.string().min(1),
    entry: z.string().min(1),
    headRebinds: z.array(reportHeadRebindSchema).optional(),
});

/**
 * Builds the audited replacement document after the report boundary validates its safe path.
 */
export function rebindReportDocument(raw: unknown, input: RebindReportHeadInput) {
    const report = reportHeadSchema.parse(raw);
    /**
     * `summary` is the only marker of a finalized round, and finalization is a pure local recompute from the unchanged
     * cases: publication to LobeHub is the irreversible boundary, not this. So a finalized but unpublished round may
     * still follow a non-product head, provided the delta is machine-checked. Its derived `summary` is dropped so the
     * round cannot be published until the caller re-finalizes against the new head.
     */
    const wasFinalized = 'summary' in report;
    if (wasFinalized) {
        if (!input.allowFinalized) {
            throw new Error(
                'A finalized Acceptance report needs --allow-finalized and must be unpublished',
            );
        }
        if (!input.changedPaths) {
            throw new Error('A finalized Acceptance report needs the resolved rebind delta');
        }
        if (input.changedPaths.some((path) => !path.startsWith(NON_PRODUCT_REBIND_PREFIX))) {
            throw new Error(
                'A finalized Acceptance report can only be rebound onto a non-product head',
            );
        }
    }
    if (report.commit !== input.fromCommit) {
        throw new Error('Acceptance report commit does not match --from-commit');
    }
    if (input.commit === input.fromCommit) {
        throw new Error('Acceptance report replacement commit must differ from --from-commit');
    }
    const reboundAt = z.iso.datetime().parse(input.createdAt ?? new Date().toISOString());
    const carried = { ...report };
    if (wasFinalized) delete carried.summary;
    return {
        ...carried,
        commit: z.string().trim().min(1).parse(input.commit),
        createdAt: reboundAt,
        entry: validateHumanText(input.entry, 'entry'),
        headRebinds: [
            ...(report.headRebinds ?? []),
            {
                fromCommit: input.fromCommit,
                reason: z.string().trim().min(1).parse(input.reason),
                reboundAt,
                toCommit: input.commit,
            },
        ],
    };
}
