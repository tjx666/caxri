import claudeCode from '@lobehub/icons-static-svg/icons/claudecode-color.svg?no-inline';
import codex from '@lobehub/icons-static-svg/icons/codex-color.svg?no-inline';
import grok from '@lobehub/icons-static-svg/icons/grok.svg?no-inline';
import openCode from '@lobehub/icons-static-svg/icons/opencode.svg?no-inline';

import { agentProviderCatalog, agentProviderIds, type AgentProvider } from '@shared/agents';
import type { TerminalKind } from '@shared/types';

export type AgentIconIdentity = TerminalKind | 'grok' | 'opencode' | 'unknown';

export interface AgentIconDefinition {
    id: AgentIconIdentity;
    label: string;
    kind: 'color-asset' | 'mask-asset' | 'shell' | 'unknown';
    src?: string;
}

const managedAgentIconAssets = {
    claude: { kind: 'color-asset', src: claudeCode },
    codex: { kind: 'color-asset', src: codex },
} as const satisfies Record<AgentProvider, Pick<AgentIconDefinition, 'kind' | 'src'>>;

const managedAgentIcons = Object.fromEntries(
    agentProviderIds.map((provider) => [
        provider,
        {
            id: provider,
            label: agentProviderCatalog[provider].displayName,
            ...managedAgentIconAssets[provider],
        },
    ]),
) as Record<AgentProvider, AgentIconDefinition>;

export const agentIconRegistry = {
    ...managedAgentIcons,
    grok: { id: 'grok', kind: 'mask-asset', label: 'Grok', src: grok },
    opencode: { id: 'opencode', kind: 'mask-asset', label: 'OpenCode', src: openCode },
    shell: { id: 'shell', kind: 'shell', label: 'Shell' },
    unknown: { id: 'unknown', kind: 'unknown', label: 'Unknown Agent' },
} satisfies Record<AgentIconIdentity, AgentIconDefinition>;

export function resolveAgentIcon(identity?: string | null): AgentIconDefinition {
    return identity && Object.hasOwn(agentIconRegistry, identity)
        ? agentIconRegistry[identity as AgentIconIdentity]
        : agentIconRegistry.unknown;
}
