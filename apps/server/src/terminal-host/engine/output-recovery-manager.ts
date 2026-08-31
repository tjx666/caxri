import type { AgentOutputRecoverySettings, AgentProvider, ServerEvent } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import { AgentOutputRecovery, hasEnabledOutputRecoveryRules } from './output-recovery';
import type { LiveTerminal } from './types';

interface LiveOutputRecoveryOptions {
    emit: (event: ServerEvent) => void;
    getSettings?: (provider: AgentProvider) => AgentOutputRecoverySettings;
    isCurrent: () => boolean;
    logger: StructuredLogger;
    provider?: AgentProvider;
    write: (data: string) => boolean;
}

export function hasConfiguredOutputRecovery(
    getSettings?: (provider: AgentProvider) => AgentOutputRecoverySettings,
): boolean {
    return Boolean(
        getSettings &&
        agentProviderIds.some((provider) => {
            const settings = getSettings(provider);
            return hasEnabledOutputRecoveryRules(provider, settings);
        }),
    );
}

/**
 * Reconciles the recovery owner with the Terminal's durable provider. Provider promotion and switching happen after PTY
 * spawn, so the live launch record alone cannot safely select which provider settings authorize input.
 */
export function ensureLiveOutputRecovery(
    live: LiveTerminal,
    options: LiveOutputRecoveryOptions,
): AgentOutputRecovery | undefined {
    const settings =
        options.provider && options.getSettings ? options.getSettings(options.provider) : undefined;
    if (
        !settings ||
        !options.provider ||
        !hasEnabledOutputRecoveryRules(options.provider, settings)
    ) {
        live.outputRecovery?.dispose();
        live.outputRecovery = undefined;
        live.outputRecoveryProvider = undefined;
        return;
    }
    if (live.outputRecovery && live.outputRecoveryProvider === options.provider)
        return live.outputRecovery;
    live.outputRecovery?.dispose();
    const provider = options.provider;
    live.outputRecoveryProvider = provider;
    live.outputRecovery = new AgentOutputRecovery({
        terminalId: live.record.id,
        provider,
        logger: options.logger,
        getSettings: () => options.getSettings!(provider),
        isCurrent: options.isCurrent,
        readTail: (maximumCharacters) => live.screen.textTail(maximumCharacters),
        write: options.write,
        onStatus: (status) =>
            options.emit({
                event: 'terminal.outputRecovery',
                payload: { terminalId: live.record.id, provider, status },
            }),
    });
    return live.outputRecovery;
}
