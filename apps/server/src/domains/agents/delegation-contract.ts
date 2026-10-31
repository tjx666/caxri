import type {
    AgentDelegationReceipt,
    AgentDelegationUsage,
    AgentLaunchSettings,
    DelegationSelection,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { expandLaunchArguments } from '@caxri/utils';

import type { AgentEnvironment } from './contract';

export interface DelegationEvidence {
    sessionId: string;
    promptDigest: string;
    answerDigest?: string;
    answerByteLength?: number;
    answerStopCount?: number;
    answerOverflow?: boolean;
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
    /**
     * Native finality is incremental, but this provider stores answer chunks in earlier records.
     */
    completionRequiresTranscript?: boolean;
    /**
     * The native record has no turn-end marker, so only the provider's final `Stop` hook proves an answer is final.
     * Collection waits for it instead of polling a running turn, and a restart collects only a task that saw it.
     */
    completionAwaitsStop?: boolean;
    /**
     * Reads the native conversation as delegation content when it is not a transcript file Caxri can tail.
     */
    readTranscript?(
        this: void,
        sessionId: string,
        environment: AgentEnvironment,
    ): Promise<string | undefined>;
    createSessionId(): string | undefined;
    validateLaunch(launch: AgentLaunchSettings): void;
    selectLaunch(launch: AgentLaunchSettings, selection: DelegationSelection): AgentLaunchSettings;
    verifyVersion(version: string | undefined): void;
    freshLaunch?(
        this: void,
        launch: AgentLaunchSettings,
        pointer: string,
        directory: string,
        sessionId?: string,
    ): AgentLaunchSettings;
    resumeLaunch?(this: void, launch: AgentLaunchSettings, directory: string): AgentLaunchSettings;
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
    const arguments_ = expandLaunchArguments(launch.args);
    for (let index = 0; index < arguments_.length; index++) {
        const argument = arguments_[index];
        const flag = argument.split('=', 1)[0];
        if (booleanFlags.has(argument)) continue;
        if (valueFlags.has(flag)) {
            const value = argument.includes('=')
                ? argument.slice(flag.length + 1)
                : arguments_[++index];
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
    const source = expandLaunchArguments(launch.args);
    const arguments_: string[] = [];
    for (let index = 0; index < source.length; index++) {
        const argument = source[index];
        if (flags.has(argument.split('=', 1)[0])) {
            if (!argument.includes('=')) index++;
        } else arguments_.push(argument);
    }
    return { ...launch, args: [...arguments_, ...replacement] };
}
