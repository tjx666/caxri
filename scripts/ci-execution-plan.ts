import { isReusableGreenDeltaPath, isReusableGreenSkillPath } from './ci-green-reuse';

export type CIChecksScope =
    'focused-docs' | 'focused-skills' | 'focused-source' | 'full' | 'skipped';
type CIE2EProfile = 'control' | 'optimized';

export interface CIExecutionPlanInput {
    changedFiles: string[];
    dispatchE2EProfile?: 'control' | 'optimized' | 'skip';
    eventName: string;
    isReleaseCommit?: boolean;
    pullRequestDraft?: boolean;
    reusableGreenRun?: CIReusableGreenRun;
    retryMode?: 'e2e-only' | 'e2e-repair';
}

export interface CIReusableGreenRun {
    changedFiles: string[];
    headSha: string;
    runId: number;
}

export interface CIExecutionPlan {
    checksScope: CIChecksScope;
    e2eProfile: CIE2EProfile;
    reason: string;
    runE2E: boolean;
}

function isDocumentationPath(path: string): boolean {
    return path.endsWith('.md') || path.startsWith('docs/');
}

function isRepoSkillPath(path: string): boolean {
    return path.startsWith('.agents/skills/') || path.startsWith('.claude/skills/');
}

function areAllPathsMatching(
    paths: readonly string[],
    isMatch: (path: string) => boolean,
): boolean {
    return paths.length > 0 && paths.every(isMatch);
}

/**
 * Selects the cheapest fail-closed CI path that still validates the event's product risk. `ready_for_review`
 * re-evaluates the same source SHA with `draft=false`, promoting it to full CI.
 */
export function evaluateCIExecutionPlan(input: CIExecutionPlanInput): CIExecutionPlan {
    if (input.retryMode) {
        return {
            checksScope: 'skipped',
            e2eProfile: 'control',
            reason: `validated ${input.retryMode} receipt`,
            runE2E: true,
        };
    }

    if (input.eventName === 'workflow_dispatch') {
        const profile = input.dispatchE2EProfile ?? 'skip';
        return {
            checksScope: 'full',
            e2eProfile: profile === 'optimized' ? 'optimized' : 'control',
            reason: 'self-hosted performance dispatch',
            runE2E: profile !== 'skip',
        };
    }

    if (input.eventName === 'pull_request') {
        const reusable = input.reusableGreenRun;
        if (
            reusable &&
            Number.isSafeInteger(reusable.runId) &&
            reusable.runId > 0 &&
            /^[0-9a-f]{40}$/u.test(reusable.headSha) &&
            areAllPathsMatching(reusable.changedFiles, isReusableGreenDeltaPath)
        ) {
            const isSkillDelta = reusable.changedFiles.some(isReusableGreenSkillPath);
            return {
                checksScope: isSkillDelta ? 'focused-skills' : 'focused-docs',
                e2eProfile: 'control',
                reason: `ancestor full-green run ${reusable.runId}; ${isSkillDelta ? 'repository-skill' : 'documentation'} delta`,
                runE2E: false,
            };
        }
        if (
            input.changedFiles.some(isRepoSkillPath) &&
            areAllPathsMatching(
                input.changedFiles,
                (path) => isDocumentationPath(path) || isRepoSkillPath(path),
            )
        ) {
            return {
                checksScope: 'focused-skills',
                e2eProfile: 'control',
                reason: 'repository-skill only pull request',
                runE2E: false,
            };
        }
        if (areAllPathsMatching(input.changedFiles, isDocumentationPath)) {
            return {
                checksScope: 'focused-docs',
                e2eProfile: 'control',
                reason: 'documentation-only pull request',
                runE2E: false,
            };
        }
        if (input.pullRequestDraft) {
            return {
                checksScope: 'focused-source',
                e2eProfile: 'control',
                reason: 'draft source pull request',
                runE2E: false,
            };
        }
        return {
            checksScope: 'full',
            e2eProfile: 'optimized',
            reason: 'ready source pull request',
            runE2E: true,
        };
    }

    if (input.eventName === 'push') {
        return {
            checksScope: 'full',
            e2eProfile: 'control',
            reason: input.isReleaseCommit ? 'exact release commit' : 'ordinary main push',
            runE2E: input.isReleaseCommit === true,
        };
    }

    /**
     * Unknown future event types pay the macOS cost instead of silently weakening CI.
     */
    return {
        checksScope: 'full',
        e2eProfile: 'control',
        reason: `unknown event ${input.eventName || 'missing'}; running full CI`,
        runE2E: true,
    };
}
