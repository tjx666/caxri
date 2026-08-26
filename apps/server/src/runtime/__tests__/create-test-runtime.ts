import type { AgentProvider } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';
import type { IPty } from 'node-pty';
import { vi } from 'vitest';

import type { AgentAdapter } from '../agents/service';
import { AgentService } from '../agents/service';

/**
 * Creates the inert PTY used by Runtime composition tests that must not launch a login shell. Tests that need to emit
 * PTY data or exit events should keep a richer domain-local fake.
 */
export function createFakePty(): IPty {
    return {
        pid: 4242,
        kill: vi.fn(),
        onData: vi.fn(() => ({ dispose: vi.fn() })),
        onExit: vi.fn(() => ({ dispose: vi.fn() })),
        resize: vi.fn(),
        write: vi.fn(),
    } as unknown as IPty;
}

/**
 * Prevents background Agent metadata probes from escaping hermetic Runtime composition tests.
 */
export function createPendingAgentAdapters(
    overrides: Partial<Record<AgentProvider, AgentAdapter>> = {},
): Record<AgentProvider, AgentAdapter> {
    const pending = new Promise<never>(() => {});
    return Object.fromEntries(
        agentProviderIds.map((provider) => [
            provider,
            overrides[provider] ?? { provider, snapshot: () => pending },
        ]),
    ) as Record<AgentProvider, AgentAdapter>;
}

/**
 * Keeps focused Agent tests exhaustive for the catalog without making every fixture restate inert providers.
 */
export function createTestAgentService(
    overrides: Partial<Record<AgentProvider, AgentAdapter>> = {},
    logger?: ConstructorParameters<typeof AgentService>[0],
): AgentService {
    return new AgentService(logger, createPendingAgentAdapters(overrides));
}
