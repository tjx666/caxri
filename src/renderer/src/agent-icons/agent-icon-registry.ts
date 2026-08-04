import claudeCode from '@lobehub/icons-static-svg/icons/claudecode-color.svg?no-inline';
import codex from '@lobehub/icons-static-svg/icons/codex-color.svg?no-inline';
import grok from '@lobehub/icons-static-svg/icons/grok.svg?no-inline';
import openCode from '@lobehub/icons-static-svg/icons/opencode.svg?no-inline';

import type { TerminalKind } from '@shared/types';

export type AgentIconIdentity = TerminalKind | 'grok' | 'opencode' | 'unknown';

export interface AgentIconDefinition {
    id: AgentIconIdentity;
    label: string;
    kind: 'color-asset' | 'mask-asset' | 'shell' | 'unknown';
    src?: string;
}

export const agentIconRegistry = {
    claude: {
        id: 'claude',
        kind: 'color-asset',
        label: 'Claude Code',
        src: claudeCode,
    },
    codex: { id: 'codex', kind: 'color-asset', label: 'Codex', src: codex },
    grok: { id: 'grok', kind: 'mask-asset', label: 'Grok', src: grok },
    opencode: { id: 'opencode', kind: 'mask-asset', label: 'OpenCode', src: openCode },
    shell: { id: 'shell', kind: 'shell', label: 'Shell' },
    unknown: { id: 'unknown', kind: 'unknown', label: 'Unknown Agent' },
} as const satisfies Record<AgentIconIdentity, AgentIconDefinition>;

export function resolveAgentIcon(identity?: string | null): AgentIconDefinition {
    return identity && Object.hasOwn(agentIconRegistry, identity)
        ? agentIconRegistry[identity as AgentIconIdentity]
        : agentIconRegistry.unknown;
}
