import type {
    AgentDelegationReceipt,
    AgentDelegationUsage,
    AgentLaunchSettings,
    DelegationSelection,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

export interface DelegationEvidence {
    sessionId: string;
    promptDigest: string;
    answerDigest?: string;
    turnId?: string;
    continuationPromptDigests?: readonly string[];
}

export type DelegationCompletion =
    | { kind: 'answer'; text: string; messageId: string; usage?: AgentDelegationUsage }
    | {
          kind: 'failed';
          failure: NonNullable<AgentDelegationReceipt['failure']>;
          usage?: AgentDelegationUsage;
      };

/**
 * Native identity, argv and completion formats belong to the provider. The delegation service retains task files, exact
 * launch ownership, human intervention fences and durable answer storage.
 */
export interface AgentDelegationAdapter {
    completion: 'stop-digest' | 'native-completion';
    createSessionId(): string | undefined;
    validateLaunch(launch: AgentLaunchSettings): void;
    selectLaunch(launch: AgentLaunchSettings, selection: DelegationSelection): AgentLaunchSettings;
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
    extractUsage?(content: string, evidence: DelegationEvidence): AgentDelegationUsage | undefined;
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

/**
 * Replaces a provider binding as a unit so an omitted model or effort never inherits another binding's flags.
 */
export function replaceDelegationArguments(
    launch: AgentLaunchSettings,
    flags: ReadonlySet<string>,
    replacement: readonly string[],
): AgentLaunchSettings {
    const arguments_: string[] = [];
    for (let index = 0; index < launch.args.length; index++) {
        const argument = launch.args[index];
        if (flags.has(argument.split('=', 1)[0])) {
            if (!argument.includes('=')) index++;
        } else arguments_.push(argument);
    }
    return { ...launch, args: [...arguments_, ...replacement] };
}
