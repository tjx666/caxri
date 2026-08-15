import type { AgentProvider } from '../../../shared/agents';
import type { AgentProviderDescriptor } from '../contract';
import { claudeProvider } from './claude';
import { codexProvider } from './codex';

/**
 * Registry of every Agent provider descriptor, keyed by provider id.
 */
export const agentProviders = {
    claude: claudeProvider,
    codex: codexProvider,
} satisfies Record<AgentProvider, AgentProviderDescriptor>;
