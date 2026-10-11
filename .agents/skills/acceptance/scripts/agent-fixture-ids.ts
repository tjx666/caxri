import type { AgentProvider } from '@caxri/protocol';

/**
 * The closed set of repository-owned fake Agent fixtures an Acceptance plan may declare, and the provider targets each
 * one replaces. Kept apart from the fixture sources so plan validation and receipts can import the registry without
 * loading every executable body.
 */
export const acceptanceAgentFixtureIds = [
    'agent-features-v1',
    'grok-build-v1',
    'agent-delegation-v1',
    'agent-chat-v1',
] as const;
export type AcceptanceAgentFixtureId = (typeof acceptanceAgentFixtureIds)[number];

export const acceptanceAgentFixtureProviders = {
    'agent-features-v1': ['claude', 'codex'],
    'grok-build-v1': ['grok'],
    'agent-delegation-v1': ['claude', 'codex', 'grok'],
    'agent-chat-v1': ['claude', 'codex'],
} as const satisfies Record<AcceptanceAgentFixtureId, readonly AgentProvider[]>;
