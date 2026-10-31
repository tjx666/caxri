/**
 * Configuration loaders run before workspace packages are built, so this stays dependency free like the reporter
 * policy.
 *
 * CI stops a Playwright invocation after 3 failures so a broken build fails fast. Every test not yet run then becomes
 * `unknown` and the per-pool failure census reruns each one at `workers=1`, discarding the pool's parallelism. A
 * hosted-full leg sets `CAXRI_E2E_MAX_FAILURES=0` to run every test once at full parallelism and record all failures in
 * a single invocation, so the census has nothing to rerun (#1869). The shared 25-minute window still bounds a mass
 * failure.
 */
export function resolveE2EMaxFailures(environment: NodeJS.ProcessEnv): number {
    const override = environment.CAXRI_E2E_MAX_FAILURES;
    if (override !== undefined && override !== '') {
        if (!/^\d+$/u.test(override)) {
            throw new Error('CAXRI_E2E_MAX_FAILURES must be a non-negative integer');
        }
        return Number(override);
    }
    return environment.CI ? 3 : 0;
}
