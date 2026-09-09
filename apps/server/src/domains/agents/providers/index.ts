import type { AgentProvider } from '@caxri/protocol';

import type { AgentProviderDescriptor } from '../contract';
import { claudeProvider } from './claude';
import { codexProvider } from './codex';
import { grokProvider } from './grok';

/**
 * Registry of every Agent provider descriptor, keyed by provider id.
 */
export const agentProviders: Record<AgentProvider, AgentProviderDescriptor> = {
    claude: claudeProvider,
    codex: codexProvider,
    grok: grokProvider,
};
