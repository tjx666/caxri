import { setPriority } from 'node:os';

/**
 * The niceness local test runs take; `0` is the default every interactive process runs at.
 */
export const LOCAL_TEST_NICENESS = 10;

/**
 * Lowers this test runner's scheduling priority outside CI. The maintainer runs several Agent sessions whose suites
 * load every core at once, and the installed Caxri's Server Core then went seconds without CPU: its phone connection
 * missed liveness deadlines although nothing was wrong with it. Workers forked afterwards inherit the niceness, so one
 * call covers the whole run. CI runners are dedicated and keep their default priority.
 */
export const lowerLocalTestPriority = (
    environment: NodeJS.ProcessEnv,
    lower: (niceness: number) => void = (niceness) => setPriority(niceness),
): void => {
    if (environment.CI) return;
    try {
        lower(LOCAL_TEST_NICENESS);
    } catch {
        // A sandbox may forbid priority changes; tests still run, only at the default priority.
    }
};
