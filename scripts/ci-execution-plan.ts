import { isReusableGreenDeltaPath, isReusableGreenSkillPath } from './ci-green-reuse';

export type CIChecksScope =
    | 'affected'
    | 'focused-docs'
    | 'focused-e2e'
    | 'focused-harness'
    | 'focused-skills'
    | 'focused-source'
    | 'full'
    | 'skipped';
type CIE2EProfile = 'control' | 'focused' | 'optimized';

export interface CIExecutionPlanInput {
    /**
     * E2E specs selected for an affected pull request: declared in the PR body, changed by it, or importing its
     * sources. Empty falls back to the launch smoke spec.
     */
    affectedE2ETests?: string[];
    /**
     * Why affected E2E selection failed, for example a malformed `CI-E2E-Tests` line; the PR then keeps the full suite.
     */
    affectedSelectionError?: string;
    changedFiles: string[];
    dispatchE2EProfile?: 'control' | 'optimized' | 'skip';
    eventName: string;
    /**
     * True when the delta touches dependency, toolchain, workflow, or shared E2E infrastructure whose impact an import
     * graph cannot bound, so the pull request keeps the full suite.
     */
    hasFullValidationPath?: boolean;
    /**
     * True when the scheduled run's head equals the head of the previous completed scheduled run.
     */
    isNightlyHeadUnchanged?: boolean;
    isVerifiedReleaseCommit?: boolean;
    pullRequestDraft?: boolean;
    retryKind?: 'metadata-only' | 'spec-only';
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
    /**
     * Specs the `focused` profile runs for an affected pull request.
     */
    e2eTests?: string[];
    reason: string;
    runE2E: boolean;
}

export const SMOKE_E2E_SPEC = 'e2e/smoke.e2e.ts';

/**
 * Shared with `scripts/surface-matrix.ts` so the diff-driven proof matrix classifies documentation and
 * contributor-skill paths the same way the CI scope decision does instead of maintaining a second, driftable
 * classifier.
 */
export function isDocumentationPath(path: string): boolean {
    return path.endsWith('.md') || path.startsWith('docs/');
}

export function isRepoSkillPath(path: string): boolean {
    return path.startsWith('.agents/skills/') || path.startsWith('.claude/skills/');
}

function isRepoHarnessPath(path: string): boolean {
    return (
        isRepoSkillPath(path) ||
        path === 'AGENTS.md' ||
        path === 'CLAUDE.md' ||
        path === '.agents/invocation.md' ||
        path === '.claude/skills' ||
        path === '.claude/settings.json' ||
        path === '.codex/hooks.json' ||
        (path.startsWith('.agents/acceptance/') && isDocumentationPath(path))
    );
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
    if (input.retryMode && input.retryKind === 'metadata-only') {
        return {
            checksScope: 'skipped',
            e2eProfile: 'control',
            reason: `validated ${input.retryMode} receipt`,
            runE2E: true,
        };
    }
    if (input.retryMode === 'e2e-repair' && input.retryKind === 'spec-only') {
        return {
            checksScope: 'focused-e2e',
            e2eProfile: 'focused',
            reason: 'validated E2E spec-only repair',
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
            const isHarnessDelta = reusable.changedFiles.some(isRepoHarnessPath);
            const deltaKind = isSkillDelta
                ? 'repository-skill'
                : isHarnessDelta
                  ? 'repository-harness'
                  : 'documentation';
            return {
                checksScope: isSkillDelta
                    ? 'focused-skills'
                    : isHarnessDelta
                      ? 'focused-harness'
                      : 'focused-docs',
                e2eProfile: 'control',
                reason: `ancestor full-green run ${reusable.runId}; ${deltaKind} delta`,
                runE2E: false,
            };
        }
        if (
            input.changedFiles.some(isRepoHarnessPath) &&
            areAllPathsMatching(
                input.changedFiles,
                (path) => isDocumentationPath(path) || isRepoHarnessPath(path),
            )
        ) {
            const isSkillDelta = input.changedFiles.some(isRepoSkillPath);
            return {
                checksScope: isSkillDelta ? 'focused-skills' : 'focused-harness',
                e2eProfile: 'control',
                reason: 'repository-harness only pull request',
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
        if (input.affectedSelectionError) {
            return {
                checksScope: 'full',
                e2eProfile: 'optimized',
                reason: `affected E2E selection failed closed: ${input.affectedSelectionError}`,
                runE2E: true,
            };
        }
        if (input.hasFullValidationPath) {
            return {
                checksScope: 'full',
                e2eProfile: 'optimized',
                reason: 'ready pull request changes global configuration',
                runE2E: true,
            };
        }
        /**
         * Ready source PRs validate only what the diff can reach; the scheduled nightly run owns the full suite.
         */
        const e2eTests = input.affectedE2ETests?.length
            ? [...new Set(input.affectedE2ETests)].toSorted((left, right) =>
                  left.localeCompare(right),
              )
            : [SMOKE_E2E_SPEC];
        return {
            checksScope: 'affected',
            e2eProfile: 'focused',
            e2eTests,
            reason: 'ready source pull request; affected tests only',
            runE2E: true,
        };
    }

    if (input.eventName === 'schedule') {
        if (input.isNightlyHeadUnchanged) {
            return {
                checksScope: 'skipped',
                e2eProfile: 'control',
                reason: 'nightly head unchanged since the previous scheduled run',
                runE2E: false,
            };
        }
        return {
            checksScope: 'full',
            e2eProfile: 'optimized',
            reason: 'nightly full suite',
            runE2E: true,
        };
    }

    if (input.eventName === 'push') {
        if (input.isVerifiedReleaseCommit) {
            return {
                checksScope: 'skipped',
                e2eProfile: 'control',
                reason: 'exact release commit reuses merged PR CI',
                runE2E: false,
            };
        }
        /**
         * Direct pushes to main used to skip the E2E pools entirely, which let UI changes land with stale specs that
         * only failed on the next pull request (two such regressions surfaced in PR #179). Source pushes now pay for
         * the optimized pools; documentation/skill-only pushes stay cheap. An empty change list (force push, unknown
         * base) fails closed into running E2E.
         */
        const isDocumentationOnlyPush = areAllPathsMatching(
            input.changedFiles,
            (path) => isDocumentationPath(path) || isRepoHarnessPath(path),
        );
        return {
            checksScope: 'full',
            e2eProfile: isDocumentationOnlyPush ? 'control' : 'optimized',
            reason: isDocumentationOnlyPush ? 'documentation-only main push' : 'ordinary main push',
            runE2E: !isDocumentationOnlyPush,
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
