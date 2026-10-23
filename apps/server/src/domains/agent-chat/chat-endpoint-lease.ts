import type { TerminalRecord } from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import type { AgentChatServiceOptions } from './service-options';

/**
 * Applies the optional `AgentChatServiceOptions.endpoint` to one Chat process's lifetime: the generation's environment
 * joins the provider environment before spawn, it is activated once the provider is ready, and it is retired when the
 * process exits or never started. Each step is a no-op when no Endpoint is configured.
 */
export class ChatEndpointLease {
    constructor(private readonly options: Pick<AgentChatServiceOptions, 'endpoint' | 'logger'>) {}

    private async retireNow(terminalId: string): Promise<void> {
        try {
            await this.options.endpoint?.retire(terminalId);
        } catch (error: unknown) {
            this.options.logger.write('warn', logEventCatalog.agentEndpoint.retireFailed, {
                fields: { terminalId, error: errorMessage(error, 'unknown') },
            });
        }
    }

    async environment(
        terminal: TerminalRecord,
        launchId: string,
        base: NodeJS.ProcessEnv,
    ): Promise<NodeJS.ProcessEnv> {
        return { ...base, ...(await this.options.endpoint?.environment(terminal, launchId)) };
    }

    async activate(terminalId: string): Promise<void> {
        await this.options.endpoint?.activate(terminalId);
    }

    /**
     * Ends the generation in the background. A failed retirement keeps the generation fenced (see
     * `AgentEndpointLifecycle.retire`), and the next start prepares a fresh one, so it is logged, not thrown.
     */
    retire(terminalId: string): void {
        void this.retireNow(terminalId);
    }
}
