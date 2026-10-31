import type { AgentProvider } from '@caxri/protocol';

import type { AgentProviderDescriptor } from '../contract';
// oxlint-disable-next-line react-doctor/no-barrel-import -- Provider clusters require a public barrel.
import { antigravityProvider } from './antigravity';
import { claudeProvider } from './claude';
import { codexProvider } from './codex';
// oxlint-disable-next-line react-doctor/no-barrel-import -- Provider clusters require a public barrel.
import { grokProvider } from './grok';

/**
 * Registry of every Agent provider descriptor, keyed by provider id.
 */
export const agentProviders: Record<AgentProvider, AgentProviderDescriptor> = {
    antigravity: antigravityProvider,
    claude: claudeProvider,
    codex: codexProvider,
    grok: grokProvider,
};
