import type { GoState } from './state-model';

const MAX_HANDOFF_WORKFLOW_OBSERVATIONS = 3;
const MAX_REPORT_AUDIT_NOTES = 20;

function nextActionFor(state: GoState, currentIssue: GoState['issues'][number] | null): string {
    switch (state.phase) {
        case 'intake':
            return 'Classify requirements and resolve material decisions';
        case 'planning':
            return 'Freeze the issue queue and Acceptance matrix, then create the Goal';
        case 'issue_execution':
            if (!currentIssue) return 'Transition to deep_review';
            if (currentIssue.expectationDrift.status === 'detected') {
                return `Publish the material expectation-drift comment for issue #${currentIssue.number}`;
            }
            if (currentIssue.expectationDrift.status === 'decision_required') {
                return `Request the recorded scope decision for issue #${currentIssue.number}`;
            }
            if (!currentIssue.expectationDrift.assessedAt) {
                return `Assess expectation drift for issue #${currentIssue.number}`;
            }
            return `Continue issue #${currentIssue.number}: ${currentIssue.title}`;
        case 'deep_review':
            if (state.reviewGate.frozenHeadSha)
                return 'Transition the frozen review-clean head to delivery';
            return 'Complete the Goal-range deep review and repair valid findings';
        case 'delivery':
            if (state.pullRequest.status === 'checks_pending')
                return 'Wait for or repair the required PR checks';
            if (state.pullRequest.status === 'checks_blocked') {
                if (state.pullRequest.headSha !== state.reviewGate.frozenHeadSha) {
                    return 'Record a clean exact-head review decision and freeze the PR head';
                }
                if (state.ciFallback.status === 'passed') {
                    return 'Transition to Acceptance with Actions CI still externally blocked';
                }
                if (state.ciFallback.status === 'failed') {
                    return 'Repair the failure, push a new head, and wait for new Actions checks';
                }
                if (state.ciFallback.status === 'admitted') {
                    return 'Run the admitted local CI parity commands against the recorded head';
                }
                return 'Classify the zero-step failure and request explicit fallback authorization';
            }
            if (state.pullRequest.status === 'ready') return 'Transition to acceptance';
            return 'Finish PR delivery and required review';
        case 'acceptance':
            if (state.acceptance.publication.pendingAttempt) {
                return 'Retry readback for the pending Acceptance publication';
            }
            return 'Execute and publish the next immutable Acceptance round';
        case 'acceptance_handoff':
            if (!state.handoffReport) return 'Generate the exact-head handoff report';
            if (!state.handoffReport.deliveredAt)
                return 'Deliver the persisted report summary and stable Acceptance URL';
            return state.acceptance.status === 'waived'
                ? 'Transition the explicitly waived head to merge'
                : 'Transition to waiting_acceptance';
        case 'waiting_acceptance':
            if (state.acceptance.status === 'accepted') return 'Transition to merge';
            if (state.acceptance.status === 'rejected')
                return 'Fetch actionable feedback and start a new Acceptance round';
            return 'Yield to the user and query Acceptance once on the next continuation';
        case 'merge':
            return state.pullRequest.status === 'merged'
                ? 'Transition to finalization and verify every remote outcome'
                : 'Merge the exact accepted PR head';
        case 'finalization':
            if (!state.handoffReport) return 'Generate the missing durable handoff report';
            if (!state.finalization)
                return 'Generate finalization.json from refreshed remote state';
            if (!state.handoffReport.deliveredAt || !state.finalization.deliveredAt)
                return 'Deliver the report and finalization receipts to the user';
            if (!state.resourceCleanup) return 'Run the final resource cleanup audit';
            return 'Transition to complete';
        case 'complete':
            return 'No remaining action';
    }
}

export function createResumeCheckpoint(state: GoState) {
    const remainingIssues = state.issues.filter(
        (issue) => !['committed', 'complete', 'deferred'].includes(issue.status),
    );
    const currentIssue =
        remainingIssues.find((issue) => ['progressing', 'reviewing'].includes(issue.status)) ??
        remainingIssues.find((issue) => issue.status === 'queued') ??
        null;
    const blockers = [
        ...(state.pullRequest.status === 'checks_blocked' && state.ciFallback.status !== 'passed'
            ? ['Required Actions CI could not start']
            : []),
        ...(state.phase === 'delivery' &&
        state.pullRequest.headSha !== state.reviewGate.frozenHeadSha
            ? ['Current PR head is not review-clean and frozen']
            : []),
        ...(state.acceptance.status === 'blocked' ? ['Acceptance is blocked'] : []),
        ...(state.acceptance.publication.pendingAttempt
            ? ['Acceptance publication is waiting for exact remote readback']
            : []),
        ...(['acceptance_handoff', 'waiting_acceptance', 'finalization'].includes(state.phase) &&
        !state.handoffReport
            ? ['Exact-head handoff report is missing']
            : []),
        ...(state.validations.some(({ result }) => result === 'pending')
            ? ['A validation command has no final process result']
            : []),
        ...(state.mutationLease?.kind === 'repair'
            ? [`Repair mutation lease is active: ${state.mutationLease.holderId}`]
            : []),
        ...state.issues.flatMap(({ expectationDrift, number }) =>
            expectationDrift.status === 'detected'
                ? [`Issue #${number} has unpublished material expectation drift`]
                : expectationDrift.status === 'decision_required'
                  ? [`Issue #${number} expectation drift requires a user decision`]
                  : [],
        ),
    ];
    const lastTransition = state.events.findLast((event) => event.type === 'phase') ?? null;
    const workflowObservations = [
        'acceptance',
        'acceptance_handoff',
        'waiting_acceptance',
    ].includes(state.phase)
        ? state.notes.workflow.slice(-MAX_HANDOFF_WORKFLOW_OBSERVATIONS).map(({ text }) => text)
        : [];
    const isReportingPhase = ['acceptance_handoff', 'finalization'].includes(state.phase);
    const auditNotes = isReportingPhase
        ? {
              tokenWaste: state.notes.token_waste
                  .slice(-MAX_REPORT_AUDIT_NOTES)
                  .map(({ text }) => text),
              truncated:
                  state.notes.token_waste.length > MAX_REPORT_AUDIT_NOTES ||
                  state.notes.workflow.length > MAX_REPORT_AUDIT_NOTES,
              workflow: state.notes.workflow.slice(-MAX_REPORT_AUDIT_NOTES).map(({ text }) => text),
          }
        : null;

    return {
        acceptance: state.acceptance,
        auditNotes,
        blockers,
        branch: state.branch,
        ciFallback: state.ciFallback,
        currentIssue: currentIssue
            ? {
                  number: currentIssue.number,
                  status: currentIssue.status,
                  title: currentIssue.title,
                  expectationDrift: currentIssue.expectationDrift,
              }
            : null,
        lastTransition,
        nextAction: nextActionFor(state, currentIssue),
        objective: state.objective,
        phase: state.phase,
        pullRequest: state.pullRequest,
        retention: state.retention,
        finalization: state.finalization,
        handoffReport: state.handoffReport,
        mutationLease: state.mutationLease,
        resourceCleanup: state.resourceCleanup,
        reviewGate: state.reviewGate,
        reviewPolicy: state.reviewPolicy,
        runBudget: state.runBudget,
        remainingIssues: remainingIssues.map(({ number, status, title }) => ({
            number,
            status,
            title,
        })),
        status: state.status,
        updatedAt: state.updatedAt,
        validationBudget: state.validationBudget,
        validations: state.validations,
        worktree: state.worktree,
        workflowObservations,
    };
}

export function formatResumeCheckpoint(
    checkpoint: ReturnType<typeof createResumeCheckpoint>,
): string {
    const lines = [
        `phase: ${checkpoint.phase} (${checkpoint.status})`,
        `next: ${checkpoint.nextAction}`,
    ];
    if (checkpoint.currentIssue) {
        lines.push(
            `issue: #${checkpoint.currentIssue.number} ${checkpoint.currentIssue.status} - ${checkpoint.currentIssue.title}`,
        );
    }
    if (checkpoint.pullRequest.number) {
        lines.push(
            `pr: #${checkpoint.pullRequest.number} ${checkpoint.pullRequest.status} @ ${checkpoint.pullRequest.headSha ?? 'unknown'}`,
        );
    }
    if (checkpoint.worktree) {
        lines.push(
            `worktree: ${checkpoint.worktree.path} @ ${checkpoint.worktree.baseSha} (${checkpoint.branch ?? 'no branch'})`,
        );
    }
    if (checkpoint.acceptance.id) {
        lines.push(
            `acceptance: ${checkpoint.acceptance.status} round ${checkpoint.acceptance.round}${checkpoint.acceptance.acceptedHeadSha ? ` @ ${checkpoint.acceptance.acceptedHeadSha}` : ''}`,
        );
    }
    if (checkpoint.ciFallback.status !== 'not_requested') {
        lines.push(`local-ci-fallback: ${checkpoint.ciFallback.status}`);
    }
    if (checkpoint.reviewGate.frozenHeadSha) {
        lines.push(`review-frozen-head: ${checkpoint.reviewGate.frozenHeadSha}`);
    }
    if (checkpoint.mutationLease) {
        lines.push(
            `mutation-lease: ${checkpoint.mutationLease.kind}:${checkpoint.mutationLease.holderId}`,
        );
    }
    lines.push(`review-policy: ${checkpoint.reviewPolicy.mode}`);
    if (checkpoint.handoffReport) {
        lines.push(
            `handoff-report: ${checkpoint.handoffReport.deliveredAt ? 'delivered' : 'generated'} @ ${checkpoint.handoffReport.headSha}`,
        );
    }
    if (checkpoint.finalization) {
        lines.push(
            `finalization: ${checkpoint.finalization.deliveredAt ? 'delivered' : 'generated'} @ ${checkpoint.finalization.mergeSha}`,
        );
    }
    if (checkpoint.resourceCleanup) {
        lines.push(
            `resource-cleanup: ${checkpoint.resourceCleanup.status}${checkpoint.resourceCleanup.recovered.length > 0 ? ` (${checkpoint.resourceCleanup.recovered.join(', ')})` : ''}`,
        );
    }
    const pendingValidations = checkpoint.validations.filter(({ result }) => result === 'pending');
    if (pendingValidations.length > 0) {
        lines.push(
            ...pendingValidations.map(
                ({ childPid, command, id, logPath, runnerPid, sessionId }) =>
                    `pending-validation: ${id} session=${sessionId} runner=${runnerPid ?? 'unknown'} child=${childPid ?? 'unknown'} log=${logPath} command=${command}`,
            ),
        );
    }
    if (checkpoint.validationBudget.fullElectronE2eRuns.length > 0) {
        lines.push(
            `full-electron-e2e-runs: ${checkpoint.validationBudget.fullElectronE2eRuns.length}/2`,
        );
    }
    if (checkpoint.workflowObservations.length > 0) {
        lines.push(
            'workflow observations:',
            ...checkpoint.workflowObservations.map((observation) => `- ${observation}`),
        );
    }
    if (checkpoint.auditNotes) {
        lines.push(
            'report audit notes:',
            ...checkpoint.auditNotes.tokenWaste.map(
                (observation) => `- token_waste: ${observation}`,
            ),
            ...checkpoint.auditNotes.workflow.map((observation) => `- workflow: ${observation}`),
        );
        if (checkpoint.auditNotes.truncated) {
            lines.push('- more notes available through state.ts notes --json');
        }
    }
    if (checkpoint.blockers.length > 0) lines.push(`blockers: ${checkpoint.blockers.join('; ')}`);
    lines.push(`updated: ${checkpoint.updatedAt}`);
    return lines.join('\n');
}
