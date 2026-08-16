export const PLATFORM_NEUTRAL_CI_COMMANDS = [
    'bun run lint',
    'bun run lint:markdown',
    'bun run knip',
    'bun run doctor:changed',
    'bun run typecheck',
    'bun run format:check',
    'bun run scripts/ci-metrics.ts --label "Vitest full suite partition=${CAXRI_VITEST_PARTITION} workers=${CAXRI_VITEST_MAX_WORKERS}" -- bun run test',
    'bun run scripts/ci-metrics.ts --label "Electron Vite build" -- bun run build',
] as const;

interface PlatformNeutralGateContext {
    validations: Array<{ command: string; headSha: string; kind: string; result: string }>;
}

/**
 * Requires every canonical CI command to have a passed receipt on the review's exact head.
 */
export function assertCanonicalPlatformNeutralGate(
    state: PlatformNeutralGateContext,
    headSha: string,
): void {
    const passedCommands = new Set(
        state.validations
            .filter(
                (validation) =>
                    validation.headSha === headSha &&
                    validation.kind === 'gates' &&
                    validation.result === 'passed',
            )
            .map(({ command }) => command),
    );
    const missing = PLATFORM_NEUTRAL_CI_COMMANDS.filter((command) => !passedCommands.has(command));
    if (missing.length > 0) {
        throw new Error(
            `Full deep review requires canonical platform-neutral gate receipts for the exact head; missing: ${missing.join(', ')}`,
        );
    }
}
