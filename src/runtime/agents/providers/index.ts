import type { AgentProvider } from '../../../shared/agents';
import { claudeProvider } from './claude';
import { codexProvider } from './codex';
import type { AgentProviderDescriptor } from '../contract';

/** Registry of every Agent provider descriptor, keyed by provider id. */
export const agentProviders = {
    claude: claudeProvider,
    codex: codexProvider,
} satisfies Record<AgentProvider, AgentProviderDescriptor>;
