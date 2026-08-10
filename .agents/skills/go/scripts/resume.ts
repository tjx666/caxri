import type { GoState } from './state';

const MAX_HANDOFF_WORKFLOW_OBSERVATIONS = 3;

function nextActionFor(state: GoState, currentIssue: GoState['issues'][number] | null): string {
    switch (state.phase) {
        case 'intake':
            return 'Classify requirements and resolve material decisions';
        case 'planning':
            return 'Freeze the issue queue and Acceptance matrix, then create the Goal';
        case 'issue_execution':
            return currentIssue
                ? `Continue issue #${currentIssue.number}: ${currentIssue.title}`
                : 'Transition to deep_review';
        case 'deep_review':
            return 'Complete the Goal-range deep review and repair valid findings';
        case 'delivery':
            if (state.pullRequest.status === 'checks_pending')
                return 'Wait for or repair the required PR checks';
            if (state.pullRequest.status === 'checks_blocked') {
                if (state.ciFallback.status === 'passed') {
                    return 'Transition to Acceptance with hosted CI still externally blocked';
                }
                if (state.ciFallback.status === 'failed') {
                    return 'Repair the failure, push a new head, and wait for new hosted checks';
                }
                if (state.ciFallback.status === 'admitted') {
                    return 'Run the admitted local CI parity commands against the recorded head';
                }
                return 'Wait for explicit user authorization before admitting a local CI fallback';
            }
            if (state.pullRequest.status === 'ready') return 'Transition to acceptance';
            return 'Finish PR delivery and required review';
        case 'acceptance':
            return 'Execute and publish the next immutable Acceptance round';
        case 'waiting_acceptance':
            if (state.acceptance.status === 'accepted') return 'Transition to merge';
            if (state.acceptance.status === 'rejected')
                return 'Fetch actionable feedback and start a new Acceptance round';
            return 'Yield to the user and query Acceptance once on the next continuation';
        case 'merge':
            return state.pullRequest.status === 'merged'
                ? 'Verify intended issue closure and remote project state'
                : 'Merge the exact accepted PR head';
        case 'self_improvement':
            return 'Classify technical debt and workflow findings';
        case 'reporting':
            return 'Refresh remote state and deliver the final report';
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
            ? ['Required hosted CI could not start']
            : []),
        ...(state.acceptance.status === 'blocked' ? ['Acceptance is blocked'] : []),
    ];
    const lastTransition = state.events.findLast((event) => event.type === 'phase') ?? null;
    const workflowObservations = ['acceptance', 'waiting_acceptance'].includes(state.phase)
        ? state.notes.workflow.slice(-MAX_HANDOFF_WORKFLOW_OBSERVATIONS).map(({ text }) => text)
        : [];

    return {
        acceptance: state.acceptance,
        blockers,
        branch: state.branch,
        ciFallback: state.ciFallback,
        currentIssue: currentIssue
            ? {
                  number: currentIssue.number,
                  status: currentIssue.status,
                  title: currentIssue.title,
              }
            : null,
        lastTransition,
        nextAction: nextActionFor(state, currentIssue),
        objective: state.objective,
        phase: state.phase,
        pullRequest: state.pullRequest,
        remainingIssues: remainingIssues.map(({ number, status, title }) => ({
            number,
            status,
            title,
        })),
        status: state.status,
        updatedAt: state.updatedAt,
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
            `issue: #${checkpoint.currentIssue.number} ${checkpoint.currentIssue.status} — ${checkpoint.currentIssue.title}`,
        );
    }
    if (checkpoint.pullRequest.number) {
        lines.push(
            `pr: #${checkpoint.pullRequest.number} ${checkpoint.pullRequest.status} @ ${checkpoint.pullRequest.headSha ?? 'unknown'}`,
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
    if (checkpoint.workflowObservations.length > 0) {
        lines.push('workflow observations:');
        lines.push(...checkpoint.workflowObservations.map((observation) => `- ${observation}`));
    }
    if (checkpoint.blockers.length > 0) lines.push(`blockers: ${checkpoint.blockers.join('; ')}`);
    lines.push(`updated: ${checkpoint.updatedAt}`);
    return lines.join('\n');
}
