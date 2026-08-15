import { z } from 'zod';

import { validateHumanText } from './validate-report';

export interface RebindReportHeadInput {
    commit: string;
    createdAt?: string;
    directory: string;
    entry: string;
    fromCommit: string;
    reason: string;
}

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
Builds the audited replacement document after the report boundary validates its safe path.
 */
export function rebindReportDocument(raw: unknown, input: RebindReportHeadInput) {
    const report = reportHeadSchema.parse(raw);
    if ('summary' in report) {
        throw new Error('A finalized Acceptance report cannot be rebound');
    }
    if (report.commit !== input.fromCommit) {
        throw new Error('Acceptance report commit does not match --from-commit');
    }
    if (input.commit === input.fromCommit) {
        throw new Error('Acceptance report replacement commit must differ from --from-commit');
    }
    const reboundAt = z.iso.datetime().parse(input.createdAt ?? new Date().toISOString());
    return {
        ...report,
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
