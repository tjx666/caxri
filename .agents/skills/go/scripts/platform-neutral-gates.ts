import { PLATFORM_NEUTRAL_CI_COMMANDS } from '../../../../scripts/ci-platform-gates';
import type { CiPlatformReceipt } from './ci-platform-receipt';

export {
    PLATFORM_NEUTRAL_CI_COMMANDS,
    PLATFORM_NEUTRAL_CI_GATES,
} from '../../../../scripts/ci-platform-gates';

interface PlatformNeutralGateContext {
    validations: Array<{ command: string; headSha: string; kind: string; result: string }>;
}

export interface PlatformGateReceipt {
    ciCommands: string[];
    ciRunId: number | null;
    ciRunUrl: string | null;
    localCommands: string[];
    source: 'ci' | 'local';
}

export function missingCanonicalPlatformNeutralGates(
    state: PlatformNeutralGateContext,
    headSha: string,
): string[] {
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
    return PLATFORM_NEUTRAL_CI_COMMANDS.filter((command) => !passedCommands.has(command));
}

/**
 * Requires every canonical CI command to have a passed receipt on the review's exact head.
 */
export function assertCanonicalPlatformNeutralGate(
    state: PlatformNeutralGateContext,
    headSha: string,
    ciReceipt?: CiPlatformReceipt | null,
): PlatformGateReceipt {
    const missing = missingCanonicalPlatformNeutralGates(state, headSha);
    const localCommands = PLATFORM_NEUTRAL_CI_COMMANDS.filter(
        (command) => !missing.includes(command),
    );
    if (missing.length === 0) {
        return { ciCommands: [], ciRunId: null, ciRunUrl: null, localCommands, source: 'local' };
    }
    if (
        ciReceipt?.headSha === headSha &&
        Number.isSafeInteger(ciReceipt.runId) &&
        ciReceipt.runId > 0 &&
        missing.every((command) => ciReceipt.commands.includes(command))
    ) {
        return {
            ciCommands: missing,
            ciRunId: ciReceipt.runId,
            ciRunUrl: ciReceipt.runUrl,
            localCommands,
            source: 'ci',
        };
    }
    throw new Error(
        `Full deep review requires canonical platform-neutral gate receipts for the exact head; missing: ${missing.join(', ')}. Wait for a successful exact-head full CI run or record local gate receipts.`,
    );
}
