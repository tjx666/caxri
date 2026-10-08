import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { validateHumanText } from '../../acceptance/scripts/validate-report';
import { captureCommand } from './command-runner';

const GITHUB_COMMENT_PAGE_SIZE = 100;
const MAX_GITHUB_COMMENT_PAGES = 10;

export const materialDriftKindSchema = z.enum([
    'disproven_root_cause',
    'partial_root_cause',
    'architecture_change',
    'acceptance_change',
    'scope_change',
    'already_satisfied',
]);
export const nonMaterialDriftKindSchema = z.enum([
    'equivalent_refactor',
    'test_split',
    'formatting',
    'internal_detail',
]);
export const driftKindSchema = z.union([materialDriftKindSchema, nonMaterialDriftKindSchema]);
const expectationDriftStatusSchema = z.enum(['none', 'detected', 'commented', 'decision_required']);

const driftRecordSchema = z.object({
    acceptanceImpact: z.string().min(1),
    classification: materialDriftKindSchema,
    commentUrl: z.url().nullable(),
    commentedAt: z.string().nullable(),
    decision: z.string().min(1),
    decisionRequired: z.boolean(),
    detectedAt: z.string(),
    driftKey: z.string().min(1),
    evidence: z.string().min(1),
    expectation: z.string().min(1),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    headSha: z.string().min(1),
    id: z.string().min(1),
    supersededBy: z.string().min(1).nullable(),
});

export const issueExpectationDriftSchema = z.object({
    assessedAt: z.string().nullable(),
    assessmentHeadSha: z.string().min(1).nullable(),
    records: z.array(driftRecordSchema),
    status: expectationDriftStatusSchema,
});

export type IssueExpectationDrift = z.infer<typeof issueExpectationDriftSchema>;
export type DriftRecord = z.infer<typeof driftRecordSchema>;

interface DriftIssue {
    expectationDrift: IssueExpectationDrift;
    number: number;
}

interface DriftContext {
    issues: DriftIssue[];
}

export interface AssessDriftInput {
    acceptanceImpact?: string;
    decision?: string;
    decisionRequired?: boolean;
    driftKey: string;
    evidence?: string;
    expectation?: string;
    headSha: string;
    issueNumber: number;
    kind: z.infer<typeof driftKindSchema>;
}

type CommentPublisher = (input: {
    body: string;
    fingerprint: string;
    issueNumber: number;
}) => Promise<{ url: string }>;
type CommandRunner = (command: string, arguments_: string[]) => Promise<string>;

export function createEmptyIssueExpectationDrift(): IssueExpectationDrift {
    return { assessedAt: null, assessmentHeadSha: null, records: [], status: 'none' };
}

export function isMaterialExpectationDrift(
    kind: z.infer<typeof driftKindSchema>,
): kind is z.infer<typeof materialDriftKindSchema> {
    return materialDriftKindSchema.safeParse(kind).success;
}

function issueFor(state: DriftContext, issueNumber: number): DriftIssue {
    const issue = state.issues.find(({ number }) => number === issueNumber);
    if (!issue) throw new Error(`Unknown issue: #${issueNumber}`);
    return issue;
}

function activeRecords(drift: IssueExpectationDrift): DriftRecord[] {
    return drift.records.filter(({ supersededBy }) => supersededBy === null);
}

/**
 * Why a drift record is not finished yet, or `null` once it is. Both the issue's blocking status and the guard on
 * non-material assessment read this one answer: a guard that let through anything the status still blocks on would be a
 * gate that disagrees with the report it feeds.
 */
function unsettledDriftReason(record: DriftRecord): 'decision_required' | 'detected' | null {
    if (record.decisionRequired) return 'decision_required';
    if (record.commentUrl === null) return 'detected';
    return null;
}

function refreshStatus(drift: IssueExpectationDrift): void {
    const reasons = new Set(activeRecords(drift).map(unsettledDriftReason));
    if (reasons.has('decision_required')) {
        drift.status = 'decision_required';
    } else if (reasons.has('detected')) {
        drift.status = 'detected';
    } else if (drift.records.length > 0) {
        drift.status = 'commented';
    } else {
        drift.status = 'none';
    }
}

function fingerprint(input: AssessDriftInput): string {
    return createHash('sha256')
        .update(
            JSON.stringify({
                acceptanceImpact: input.acceptanceImpact,
                decision: input.decision,
                decisionRequired: Boolean(input.decisionRequired),
                driftKey: input.driftKey,
                evidence: input.evidence,
                expectation: input.expectation,
                headSha: input.headSha,
                kind: input.kind,
            }),
        )
        .digest('hex');
}

export function assessExpectationDrift(
    state: DriftContext,
    input: AssessDriftInput,
    assessedAt = new Date().toISOString(),
): { material: boolean; record: DriftRecord | null } {
    const issue = issueFor(state, input.issueNumber);
    issue.expectationDrift.assessedAt = assessedAt;
    issue.expectationDrift.assessmentHeadSha = input.headSha;
    if (!isMaterialExpectationDrift(input.kind)) {
        /**
         * A settled material drift does not block a later non-material assessment, because this path is how an issue
         * re-attests at a delivery head that moved after its own commit. Every cross-issue repair moves that head, and
         * Acceptance requires each issue to be assessed at the exact head being delivered, so an issue whose decision
         * was published rounds earlier lands here. Rejecting it would leave only one way forward: re-assert the same
         * decision at the new head, which the head-scoped fingerprint reads as a new revision and would publish as a
         * verbatim duplicate of a comment the workflow says never to duplicate.
         *
         * What this guard actually owns is unfinished drift: a decision nobody published, or one still waiting on the
         * user. Those still block, and the published record stays active and visible either way.
         */
        const unsettled = activeRecords(issue.expectationDrift)
            .map(unsettledDriftReason)
            .find((reason) => reason !== null);
        if (unsettled) {
            throw new Error(
                unsettled === 'detected'
                    ? 'A non-material assessment cannot clear an unpublished material drift: publish it with drift-comment first'
                    : 'A non-material assessment cannot clear a material drift that is still waiting on the user: publish the resolved decision revision first',
            );
        }
        refreshStatus(issue.expectationDrift);
        return { material: false, record: null };
    }

    const expectation = validateHumanText(input.expectation, 'issue drift expectation');
    const evidence = validateHumanText(input.evidence, 'issue drift evidence');
    const decision = validateHumanText(input.decision, 'issue drift decision');
    const acceptanceImpact = validateHumanText(
        input.acceptanceImpact,
        'issue drift Acceptance impact',
    );
    const nextFingerprint = fingerprint(input);
    const current = activeRecords(issue.expectationDrift).find(
        ({ driftKey }) => driftKey === input.driftKey,
    );
    if (current?.fingerprint === nextFingerprint) return { material: true, record: current };

    const revision =
        issue.expectationDrift.records.filter(({ driftKey }) => driftKey === input.driftKey)
            .length + 1;
    const id = `${input.driftKey}-r${revision}`;
    if (current) current.supersededBy = id;
    const record = driftRecordSchema.parse({
        acceptanceImpact,
        classification: input.kind,
        commentUrl: null,
        commentedAt: null,
        decision,
        decisionRequired: Boolean(input.decisionRequired),
        detectedAt: assessedAt,
        driftKey: input.driftKey,
        evidence,
        expectation,
        fingerprint: nextFingerprint,
        headSha: input.headSha,
        id,
        supersededBy: null,
    });
    issue.expectationDrift.records.push(record);
    refreshStatus(issue.expectationDrift);
    return { material: true, record };
}

export function buildExpectationDriftComment(record: DriftRecord): string {
    const body = `## 实现决策回写

- **原预期**：${record.expectation}
- **实际发现**：${record.evidence}
- **处理决定**：${record.decision}
- **验收影响**：${record.acceptanceImpact}

关联 head：\`${record.headSha}\`
`;
    validateHumanText(body, 'issue drift comment');
    return `${body}\n<!-- caxri-go-drift:${record.fingerprint} -->\n`;
}

export async function publishExpectationDriftComment(
    state: DriftContext,
    input: { issueNumber: number; recordId: string },
    publish: CommentPublisher,
    commentedAt = new Date().toISOString(),
): Promise<DriftRecord> {
    const issue = issueFor(state, input.issueNumber);
    const record = issue.expectationDrift.records.find(({ id }) => id === input.recordId);
    if (!record) throw new Error(`Unknown issue drift record: ${input.recordId}`);
    if (record.supersededBy) throw new Error('Superseded issue drift cannot be published');
    if (record.commentUrl) return record;
    const published = await publish({
        body: buildExpectationDriftComment(record),
        fingerprint: record.fingerprint,
        issueNumber: input.issueNumber,
    });
    record.commentUrl = z.url().parse(published.url);
    record.commentedAt = commentedAt;
    refreshStatus(issue.expectationDrift);
    return record;
}

export function assertIssueExpectationDriftReady(
    issue: DriftIssue,
    expectedHeadSha?: string,
): void {
    const drift = issue.expectationDrift;
    if (!drift.assessedAt) {
        throw new Error(`Issue #${issue.number} requires an expectation-drift assessment`);
    }
    if (drift.status === 'detected') {
        throw new Error(`Issue #${issue.number} has material expectation drift without a comment`);
    }
    if (drift.status === 'decision_required') {
        throw new Error(`Issue #${issue.number} expectation drift requires a user decision`);
    }
    if (
        expectedHeadSha &&
        drift.assessedAt !== 'legacy-unavailable' &&
        drift.assessmentHeadSha !== expectedHeadSha
    ) {
        throw new Error(
            `Issue #${issue.number} expectation drift assessment does not match the required head`,
        );
    }
}

const githubCommentSchema = z.object({ body: z.string(), html_url: z.url() });

export function findPublishedDriftComment(pages: unknown, fingerprintValue: string): string | null {
    const marker = `<!-- caxri-go-drift:${fingerprintValue} -->`;
    const existing = z
        .array(z.array(githubCommentSchema))
        .parse(pages)
        .flat()
        .find(({ body }) => body.includes(marker));
    return existing?.html_url ?? null;
}

export async function publishExpectationDriftViaGh(
    input: {
        body: string;
        fingerprint: string;
        issueNumber: number;
    },
    runner: CommandRunner = captureCommand,
): Promise<{ url: string }> {
    const pages: unknown[][] = [];
    for (let page = 1; page <= MAX_GITHUB_COMMENT_PAGES; page += 1) {
        // eslint-disable-next-line no-await-in-loop -- pagination must run sequentially: each page's stop condition (match found or a short page) decides whether the next page is fetched at all.
        const commentsSource = await runner('gh', [
            'api',
            `repos/tjx666/caxri/issues/${input.issueNumber}/comments?per_page=${GITHUB_COMMENT_PAGE_SIZE}&page=${page}`,
        ]);
        const comments: unknown = JSON.parse(commentsSource);
        const parsedPage = z.array(z.unknown()).parse(comments);
        pages.push(parsedPage);
        if (findPublishedDriftComment(pages, input.fingerprint)) break;
        if (parsedPage.length < GITHUB_COMMENT_PAGE_SIZE) break;
        if (page === MAX_GITHUB_COMMENT_PAGES) {
            throw new Error('GitHub comment scan exceeded 1000 bounded comments');
        }
    }
    const existingUrl = findPublishedDriftComment(pages, input.fingerprint);
    if (existingUrl) return { url: existingUrl };
    const directory = await mkdtemp(join(tmpdir(), 'caxri-issue-drift-'));
    const bodyPath = join(directory, 'comment.md');
    try {
        await writeFile(bodyPath, input.body, 'utf8');
        const output = await runner('gh', [
            'issue',
            'comment',
            String(input.issueNumber),
            '--repo',
            'tjx666/caxri',
            '--body-file',
            bodyPath,
        ]);
        const url = output.match(/https:\/\/github\.com\/\S+/u)?.[0];
        if (!url) throw new Error('GitHub did not return the created issue comment URL');
        return { url };
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
}
