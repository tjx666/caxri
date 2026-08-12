import { describe, expect, it, vi } from 'vitest';

import {
    assessExpectationDrift,
    assertIssueExpectationDriftReady,
    buildExpectationDriftComment,
    findPublishedDriftComment,
    isMaterialExpectationDrift,
    publishExpectationDriftComment,
    publishExpectationDriftViaGh,
} from './issue-drift';
import { createResumeCheckpoint } from './resume';
import { createInitialState, recordPullRequest, upsertIssue } from './state';

function driftState() {
    const state = createInitialState({ objective: 'Track issue drift', runId: 'drift-test' });
    state.phase = 'issue_execution';
    state.status = 'active';
    upsertIssue(state, { number: 113, status: 'progressing', title: 'Track issue drift' });
    return state;
}

function materialAssessment(state: ReturnType<typeof driftState>, decisionRequired = false) {
    return assessExpectationDrift(state, {
        acceptanceImpact: '稳定检查 `issue-drift-comment` 改用 mock GitHub API，语义保持不变。',
        decision: decisionRequired
            ? '记录当前发现并等待靖哥决定是否扩大冻结范围。'
            : '保留冻结范围，使用结构化评论记录最终实现决定。',
        decisionRequired,
        driftKey: 'comment-publication',
        evidence: '当前实现需要通过 `gh issue comment --body-file` 获取不可变评论 URL。',
        expectation: '原方案只要求在 ledger 中保存 comment URL 和关联 head。',
        headSha: 'head-1',
        issueNumber: 113,
        kind: 'architecture_change',
    });
}

describe('Go issue expectation drift', () => {
    it.each([
        ['disproven_root_cause', true],
        ['partial_root_cause', true],
        ['architecture_change', true],
        ['acceptance_change', true],
        ['scope_change', true],
        ['already_satisfied', true],
        ['equivalent_refactor', false],
        ['test_split', false],
        ['formatting', false],
        ['internal_detail', false],
    ] as const)('classifies %s material=%s', (kind, material) => {
        expect(isMaterialExpectationDrift(kind)).toBe(material);
    });

    it('records an explicit no-material-drift assessment without creating a comment', () => {
        const state = driftState();
        const result = assessExpectationDrift(state, {
            driftKey: 'final-assessment',
            headSha: 'head-1',
            issueNumber: 113,
            kind: 'test_split',
        });

        expect(result).toEqual({ material: false, record: null });
        expect(state.issues[0].expectationDrift).toMatchObject({
            assessmentHeadSha: 'head-1',
            records: [],
            status: 'none',
        });
        expect(() =>
            upsertIssue(state, { commits: ['head-1'], number: 113, status: 'complete' }),
        ).not.toThrow();
    });

    it('builds a Chinese four-part comment and publishes it idempotently', async () => {
        const state = driftState();
        const record = materialAssessment(state).record!;
        const publisher = vi.fn(() =>
            Promise.resolve({ url: 'https://github.com/tjx666/caxri/issues/113#issuecomment-1' }),
        );

        expect(buildExpectationDriftComment(record)).toContain(
            '**原预期**：原方案只要求在 ledger 中保存 comment URL 和关联 head。',
        );
        expect(buildExpectationDriftComment(record)).toContain('**实际发现**：');
        expect(buildExpectationDriftComment(record)).toContain('**处理决定**：');
        expect(buildExpectationDriftComment(record)).toContain('**验收影响**：');
        expect(buildExpectationDriftComment(record)).toContain(
            `<!-- caxri-go-drift:${record.fingerprint} -->`,
        );
        await publishExpectationDriftComment(
            state,
            { issueNumber: 113, recordId: record.id },
            publisher,
        );
        await publishExpectationDriftComment(
            state,
            { issueNumber: 113, recordId: record.id },
            publisher,
        );

        expect(publisher).toHaveBeenCalledTimes(1);
        expect(state.issues[0].expectationDrift).toMatchObject({ status: 'commented' });
        expect(() => assertIssueExpectationDriftReady(state.issues[0])).not.toThrow();
    });

    it('recovers the same remote comment by its stable marker after a local write failure', () => {
        const state = driftState();
        const record = materialAssessment(state).record!;
        expect(
            findPublishedDriftComment(
                [
                    [
                        {
                            body: buildExpectationDriftComment(record),
                            html_url:
                                'https://github.com/tjx666/caxri/issues/113#issuecomment-recovered',
                        },
                    ],
                ],
                record.fingerprint,
            ),
        ).toBe('https://github.com/tjx666/caxri/issues/113#issuecomment-recovered');
    });

    it('reads GitHub comments in bounded pages and stops at the matching marker', async () => {
        const state = driftState();
        const record = materialAssessment(state).record!;
        const firstPage = Array.from({ length: 100 }, (_, index) => ({
            body: `comment ${index}`,
            html_url: `https://github.com/tjx666/caxri/issues/113#issuecomment-${index}`,
        }));
        const runner = vi
            .fn()
            .mockResolvedValueOnce(JSON.stringify(firstPage))
            .mockResolvedValueOnce(
                JSON.stringify([
                    {
                        body: buildExpectationDriftComment(record),
                        html_url: 'https://github.com/tjx666/caxri/issues/113#issuecomment-bounded',
                    },
                ]),
            );

        await expect(
            publishExpectationDriftViaGh(
                { body: 'unused', fingerprint: record.fingerprint, issueNumber: 113 },
                runner,
            ),
        ).resolves.toEqual({
            url: 'https://github.com/tjx666/caxri/issues/113#issuecomment-bounded',
        });
        expect(runner).toHaveBeenCalledTimes(2);
        expect(runner.mock.calls[0][1]).toEqual(
            expect.arrayContaining([expect.stringContaining('page=1')]),
        );
        expect(runner.mock.calls[1][1]).toEqual(
            expect.arrayContaining([expect.stringContaining('page=2')]),
        );
    });

    it('retains detected state when publication fails so resume can retry', async () => {
        const state = driftState();
        const record = materialAssessment(state).record!;

        await expect(
            publishExpectationDriftComment(state, { issueNumber: 113, recordId: record.id }, () =>
                Promise.reject(new Error('GitHub unavailable')),
            ),
        ).rejects.toThrow('GitHub unavailable');
        expect(state.issues[0].expectationDrift).toMatchObject({ status: 'detected' });
        expect(record.commentUrl).toBeNull();
        expect(createResumeCheckpoint(state)).toMatchObject({
            blockers: ['Issue #113 has unpublished material expectation drift'],
            nextAction: 'Publish the material expectation-drift comment for issue #113',
        });
    });

    it('fails issue-complete and PR-ready gates for unassessed or unpublished drift', () => {
        const state = driftState();
        expect(() =>
            upsertIssue(state, { commits: ['head-1'], number: 113, status: 'complete' }),
        ).toThrow('requires an expectation-drift assessment');

        materialAssessment(state);
        expect(() =>
            upsertIssue(state, { commits: ['head-1'], number: 113, status: 'complete' }),
        ).toThrow('without a comment');
        expect(() => recordPullRequest(state, { headSha: 'head-1', status: 'ready' })).toThrow(
            'without a comment',
        );
    });

    it('requires a committed issue head and reassessment at the candidate PR head', () => {
        const state = driftState();
        assessExpectationDrift(state, {
            driftKey: 'final-assessment',
            headSha: 'head-1',
            issueNumber: 113,
            kind: 'internal_detail',
        });

        expect(() => upsertIssue(state, { number: 113, status: 'complete' })).toThrow(
            'completion requires a commit',
        );
        upsertIssue(state, { commits: ['head-1'], number: 113, status: 'complete' });
        expect(() => recordPullRequest(state, { headSha: 'head-2', status: 'ready' })).toThrow(
            'does not match the required head',
        );

        assessExpectationDrift(state, {
            driftKey: 'final-pr-assessment',
            headSha: 'head-2',
            issueNumber: 113,
            kind: 'internal_detail',
        });
        expect(() =>
            recordPullRequest(state, { headSha: 'head-2', status: 'ready' }),
        ).not.toThrow();
    });

    it('keeps scope-expanding drift blocked after the discovery comment', async () => {
        const state = driftState();
        const record = materialAssessment(state, true).record!;
        await publishExpectationDriftComment(state, { issueNumber: 113, recordId: record.id }, () =>
            Promise.resolve({
                url: 'https://github.com/tjx666/caxri/issues/113#issuecomment-decision',
            }),
        );

        expect(state.issues[0].expectationDrift.status).toBe('decision_required');
        expect(() => assertIssueExpectationDriftReady(state.issues[0])).toThrow(
            'requires a user decision',
        );
    });

    it('appends a new revision when evidence changes and never edits old history', async () => {
        const state = driftState();
        const first = materialAssessment(state).record!;
        await publishExpectationDriftComment(state, { issueNumber: 113, recordId: first.id }, () =>
            Promise.resolve({
                url: 'https://github.com/tjx666/caxri/issues/113#issuecomment-first',
            }),
        );
        const second = assessExpectationDrift(state, {
            acceptanceImpact: '稳定检查 `issue-drift-comment` 增加恢复路径，不移除原检查。',
            decision: '保留原评论并追加一条新的决定评论。',
            driftKey: 'comment-publication',
            evidence: '恢复测试证明失败发布不会写入 comment URL。',
            expectation: '原先认为发布失败只需要重试命令。',
            headSha: 'head-2',
            issueNumber: 113,
            kind: 'acceptance_change',
        }).record!;

        expect(first).toMatchObject({
            commentUrl: 'https://github.com/tjx666/caxri/issues/113#issuecomment-first',
            supersededBy: second.id,
        });
        expect(second).toMatchObject({ commentUrl: null, id: 'comment-publication-r2' });
        expect(state.issues[0].expectationDrift.status).toBe('detected');
    });
});
