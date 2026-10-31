/**
 * Child-process environments for CI validation. Each child receives the job environment minus what it must not see.
 */

const E2E_ENVIRONMENT_PREFIX = 'CAXRI_E2E';

/**
 * Keeps the command-scoped checkout token out of every validation child.
 */
export function sanitizedChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const sanitized = { ...environment };
    delete sanitized.CAXRI_GITHUB_TOKEN;
    return sanitized;
}

/**
 * Environment for the full platform checks that `scripts/ci-concurrent-validation.ts` runs inside the `e2e` job. That
 * job exports `CAXRI_E2E_AGENT_MODE` for its E2E pools, but the platform checks must see the same environment as the
 * standalone `checks` job, which has no `CAXRI_E2E*` variable: Vitest suites read the E2E Agent policy from
 * `process.env`, and an inherited Agent mode without `CAXRI_E2E=1` makes that policy refuse to start (#1607).
 *
 * The checks checkout is a fresh repository holding only the fetched head and base revisions, with no remote-tracking
 * branch, so gitleaks scans from the verified base revision rather than resolving `origin/main` (#3293).
 */
export function platformChecksEnvironment(
    environment: NodeJS.ProcessEnv,
    baseRevision: string,
): NodeJS.ProcessEnv {
    const checksEnvironment = sanitizedChildEnvironment(environment);
    for (const key of Object.keys(checksEnvironment)) {
        if (key.startsWith(E2E_ENVIRONMENT_PREFIX)) delete checksEnvironment[key];
    }
    return {
        ...checksEnvironment,
        CAXRI_REACT_DOCTOR_BASE: baseRevision,
        GITLEAKS_BASE_REVISION: baseRevision,
        GITLEAKS_HEAD_REVISION: 'HEAD',
    };
}
