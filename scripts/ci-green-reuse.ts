export interface GreenRunEvidence {
    baseSha?: string;
    checksConclusion?: string;
    e2eConclusion?: string;
    event: string;
    fullChecksConclusion?: string;
    gateConclusion?: string;
    headSha: string;
    id: number;
    pullRequestNumber?: number;
    repository: string;
    runConclusion?: string;
    workflowPath?: string;
}

export interface GreenReusePolicyInput {
    candidate: GreenRunEvidence;
    changedFiles: string[];
    currentHeadSha: string;
    eventName: string;
    isAncestor: boolean;
    pullRequestBaseSha?: string;
    pullRequestNumber?: number;
    repository: string;
    workflowPath: string;
}

export interface GreenReusePolicyDecision {
    eligible: boolean;
    reason: string;
}

export function isReusableGreenSkillPath(path: string): boolean {
    return /^(?:\.agents|\.claude)\/skills\/acceptance\//u.test(path);
}

export function isReusableGreenDeltaPath(path: string): boolean {
    if (/^(?:\.agents|\.claude)\/skills\//u.test(path)) {
        return isReusableGreenSkillPath(path);
    }
    return path.endsWith('.md') || path.startsWith('docs/') || isReusableGreenSkillPath(path);
}

/**
 * Reuses macOS evidence only when a prior same-PR run fully validated the unchanged product tree. The current head
 * still receives focused hosted checks for its narrow non-product delta.
 */
export function evaluateGreenReusePolicy(input: GreenReusePolicyInput): GreenReusePolicyDecision {
    const reject = (reason: string): GreenReusePolicyDecision => ({ eligible: false, reason });

    if (input.eventName !== 'pull_request') return reject('green reuse is pull-request only');
    const candidate = input.candidate;
    if (
        !Number.isSafeInteger(candidate.id) ||
        candidate.id <= 0 ||
        !/^[0-9a-f]{40}$/u.test(candidate.headSha)
    ) {
        return reject('candidate run identity is invalid');
    }
    if (!input.pullRequestNumber || !input.pullRequestBaseSha) {
        return reject('current pull-request identity is unavailable');
    }
    if (candidate.repository !== input.repository || candidate.event !== 'pull_request') {
        return reject('candidate run belongs to a different repository or event');
    }
    if (candidate.workflowPath !== input.workflowPath) {
        return reject('candidate run uses a different workflow');
    }
    if (candidate.pullRequestNumber !== input.pullRequestNumber) {
        return reject('candidate run belongs to a different pull request');
    }
    if (candidate.baseSha !== input.pullRequestBaseSha) {
        return reject('pull-request base SHA changed');
    }
    if (
        candidate.runConclusion !== 'success' ||
        candidate.checksConclusion !== 'success' ||
        candidate.fullChecksConclusion !== 'success' ||
        candidate.e2eConclusion !== 'success' ||
        candidate.gateConclusion !== 'success'
    ) {
        return reject('candidate run must have successful full checks, e2e, and CI gate');
    }
    if (!input.isAncestor || candidate.headSha === input.currentHeadSha) {
        return reject('candidate head is not a strict ancestor of the current head');
    }
    if (input.changedFiles.length === 0) return reject('candidate has no incremental delta');
    const unsafePath = input.changedFiles.find((path) => !isReusableGreenDeltaPath(path));
    if (unsafePath) return reject(`incremental delta requires macOS E2E: ${unsafePath}`);

    return {
        eligible: true,
        reason: `ancestor run ${candidate.id} fully validated the unchanged product and E2E tree`,
    };
}
