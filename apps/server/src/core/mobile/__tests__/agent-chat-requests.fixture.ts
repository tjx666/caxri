// oxlint-disable typescript/require-await -- Async domain fakes preserve the production Promise boundary.
import type {
    AgentChatContinuationTarget,
    AgentChatHistoryPage,
    AgentChatSnapshot,
    AgentChatWaitingEntry,
    AgentProvider,
    AgentUsageReadout,
    Principal,
} from '@caxri/protocol';
import { vi } from 'vitest';

import type { ServerDomainService } from '../../domain-service';
import type { MobileAgentChatRequest } from '../agent-chat-requests';
import { invokeMobileAgentChatRequest } from '../agent-chat-requests';

export const principal: Extract<Principal, { kind: 'paired-device' }> = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'control',
    projectIds: ['project-1'],
};

export const chatSnapshot = (status: AgentChatSnapshot['status']): AgentChatSnapshot => ({
    terminalId: 'terminal-1',
    revision: 3,
    status,
    truncated: false,
    items: [
        {
            id: 'item-1',
            type: 'agentMessage',
            text: 'x'.repeat(20_000),
            streaming: false,
        },
        {
            id: 'item-2',
            type: 'fileChange',
            status: 'completed',
            changes: [{ path: '/work/demo/src/greeting.ts', kind: 'update', diff: '' }],
        },
    ],
    turns: [],
    requests: [],
});

export function domainFixture(options: {
    surface?: 'chat';
    provider?: AgentProvider;
    snapshot?: AgentChatSnapshot;
    terminals?: number;
    original?: string;
    /**
     * What Core's `agentChat.readHistory` returns.
     */
    history?: AgentChatHistoryPage;
    /**
     * What Core's `terminal.agentUsage` returns.
     */
    usage?: AgentUsageReadout | null;
    /**
     * What Core's `agentChat.pendingRequests` lists.
     */
    waiting?: AgentChatWaitingEntry[];
    /**
     * What Core's `agentChat.continuationTargets` lists.
     */
    targets?: AgentChatContinuationTarget[];
}) {
    const request = vi.fn<(method: string, parameters?: unknown) => Promise<unknown>>(
        async (method) => {
            if (method === 'terminal.queryForPrincipal')
                return {
                    terminals:
                        options.terminals === 0
                            ? []
                            : [
                                  {
                                      id: 'terminal-1',
                                      sessionId: 'session-1',
                                      kind: 'codex',
                                      title: 'Codex',
                                      lastProcessState: 'running',
                                      ...(options.surface && { surface: options.surface }),
                                      ...(options.provider && { provider: options.provider }),
                                  },
                              ],
                };
            if (method === 'agentChat.pendingRequests') return { entries: options.waiting ?? [] };
            if (method === 'agentChat.read') return options.snapshot ?? chatSnapshot('ready');
            if (method === 'mobile.session.projectRootInternal') return { rootPath: '/work/demo' };
            if (method === 'mobile.image.readInternal') return ['T1JJRw==', 'VEhVTUI='];
            if (method === 'agentChat.readHistory' && options.history) return options.history;
            if (method === 'agentChat.continuationTargets')
                return { targets: options.targets ?? [] };
            if (method === 'terminal.agentUsage') return options.usage ?? null;
            if (method === 'agentChat.readImage')
                return options.original === undefined
                    ? null
                    : { mediaType: 'image/png', data: options.original };
            throw new Error(`Unexpected ${method}`);
        },
    );
    return { domainService: { request } as unknown as ServerDomainService, request };
}

export const invoke = (
    request: MobileAgentChatRequest,
    domain: ReturnType<typeof domainFixture>,
    forward: (operation: unknown) => Promise<unknown> = vi.fn(async () => null),
): ReturnType<typeof invokeMobileAgentChatRequest> =>
    invokeMobileAgentChatRequest(request, principal, domain.domainService, forward, () => {});
