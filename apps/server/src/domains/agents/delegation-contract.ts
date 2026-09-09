import type { AgentDelegationReceipt, AgentLaunchSettings } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

export interface DelegationEvidence {
    sessionId: string;
    promptDigest: string;
    answerDigest?: string;
    turnId?: string;
    continuationPromptDigests?: readonly string[];
}

export type DelegationCompletion =
    | { kind: 'answer'; text: string; messageId: string }
    | { kind: 'failed'; failure: NonNullable<AgentDelegationReceipt['failure']> };

/**
 * Native identity, argv and completion formats belong to the provider. The delegation service retains task files, exact
 * launch ownership, human intervention fences and durable answer storage.
 */
export interface AgentDelegationAdapter {
    completion: 'stop-digest' | 'native-completion';
    createSessionId(): string | undefined;
    validateLaunch(launch: AgentLaunchSettings): void;
    verifyVersion(version: string | undefined): void;
    freshLaunch(
        launch: AgentLaunchSettings,
        pointer: string,
        directory: string,
        sessionId?: string,
    ): AgentLaunchSettings;
    resumeLaunch(launch: AgentLaunchSettings, directory: string): AgentLaunchSettings;
    extractCompletion(
        content: string,
        evidence: DelegationEvidence,
    ): DelegationCompletion | undefined;
}

/**
 * Provider-specific allowlists prevent a configured subcommand, prompt, hook override or session selector from taking
 * ownership away from the managed task.
 */
export function validateDelegationArguments(
    launch: AgentLaunchSettings,
    valueFlags: ReadonlySet<string>,
    booleanFlags: ReadonlySet<string>,
): void {
    for (let index = 0; index < launch.args.length; index++) {
        const argument = launch.args[index];
        const flag = argument.split('=', 1)[0];
        if (booleanFlags.has(argument)) continue;
        if (valueFlags.has(flag)) {
            const value = argument.includes('=')
                ? argument.slice(flag.length + 1)
                : launch.args[++index];
            if (value && !value.startsWith('-')) continue;
        }
        throw new CaxriError(
            'CONFLICT',
            'Agent launch arguments are unsupported for visible delegation',
        );
    }
}
