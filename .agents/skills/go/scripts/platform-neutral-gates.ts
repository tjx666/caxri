import { PLATFORM_NEUTRAL_CI_COMMANDS } from '../../../../scripts/ci-platform-gates';

export {
    PLATFORM_NEUTRAL_CI_COMMANDS,
    PLATFORM_NEUTRAL_CI_GATES,
} from '../../../../scripts/ci-platform-gates';

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
