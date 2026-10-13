/**
 * Validates the provider-scoped facts a main-turn finish may carry: Grok's delegated response evidence, a closed
 * failure classification, and Claude's report that background work still runs. Each is bounded to the provider and
 * phase that can produce it, so a forged flag on another provider or a subagent scope is rejected rather than ignored.
 */
export function validateTurnOutcomeSignal(
    signal: Record<string, unknown>,
): 'invalidAgentDigest' | 'invalidSignal' | undefined {
    const { phase, provider } = signal;
    if (
        signal.agentResponseByteLength !== undefined &&
        (provider !== 'grok' ||
            phase !== 'turnFinished' ||
            signal.agentId !== undefined ||
            typeof signal.agentResponseByteLength !== 'number' ||
            !Number.isSafeInteger(signal.agentResponseByteLength) ||
            signal.agentResponseByteLength < 0 ||
            signal.agentResponseByteLength > 1_048_576 ||
            !signal.agentResponseDigest)
    )
        return 'invalidAgentDigest';
    if (
        signal.agentFailure !== undefined &&
        (typeof signal.agentFailure !== 'string' ||
            (provider !== 'claude' && provider !== 'grok') ||
            (phase !== 'turnFinished' && phase !== 'turnFailed') ||
            signal.agentId !== undefined ||
            ![
                'rate_limit',
                'billing_error',
                'authentication_failed',
                'max_output_tokens',
                'provider_failed',
            ].includes(signal.agentFailure))
    )
        return 'invalidAgentDigest';
    if (
        signal.agentResponseStop !== undefined &&
        (provider !== 'grok' ||
            phase !== 'turnFinished' ||
            signal.agentResponseStop !== true ||
            signal.agentId !== undefined)
    )
        return 'invalidAgentDigest';
    if (
        signal.agentTurnContinues !== undefined &&
        (provider !== 'grok' ||
            phase !== 'turnFinished' ||
            signal.agentTurnContinues !== true ||
            signal.agentId !== undefined)
    )
        return 'invalidAgentDigest';
    if (
        signal.agentBackgroundWork !== undefined &&
        (provider !== 'claude' ||
            phase !== 'turnFinished' ||
            signal.agentBackgroundWork !== true ||
            signal.agentId !== undefined)
    )
        return 'invalidSignal';
    return undefined;
}
