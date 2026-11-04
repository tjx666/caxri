import type { AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import type { SettingRowSource } from './setting-row-source';
import { lower } from './setting-row-source';

/**
 * One Agent's section under Settings › Agents, in display order. Every row carries the provider's id and display name
 * in its search corpus, so searching for an Agent lists its whole section.
 */
export function providerSettingRows(provider: AgentProvider): SettingRowSource[] {
    const providerName = agentProviderCatalog[provider].displayName;
    const shared = {
        category: 'agents' as const,
        subcategory: { kind: 'provider', id: provider } as const,
    };
    const providerTerms = [provider, providerName, 'agent', 'provider'];
    return [
        {
            ...shared,
            id: `agents.${provider}.actions`,
            titleKey: 'settings.row.providerActions.title',
            descriptionKey: 'settings.row.providerActions.description',
            binding: { type: 'provider-actions', provider },
            searchTerms: lower([
                'agent actions',
                'agent commands & skills',
                'slash commands',
                'skills',
                'picker',
                ...providerTerms,
            ]),
        },
        {
            ...shared,
            id: `agents.${provider}.hooks`,
            advanced: true,
            titleKey: 'settings.row.providerHooks.title',
            descriptionKey: 'settings.row.providerHooks.description',
            binding: { type: 'provider-toggle', provider, field: 'hooks' },
            searchTerms: lower(['lifecycle hooks', 'unread', 'background', ...providerTerms]),
        },
        {
            ...shared,
            id: `agents.${provider}.messaging`,
            advanced: true,
            titleKey: 'settings.row.providerMessaging.title',
            descriptionKey: 'settings.row.providerMessaging.description',
            binding: { type: 'provider-toggle', provider, field: 'messaging' },
            searchTerms: lower(['peer messaging', 'inbox', ...providerTerms]),
        },
        {
            ...shared,
            id: `agents.${provider}.recovery`,
            advanced: true,
            titleKey: 'settings.row.providerRecovery.title',
            descriptionKey: 'settings.row.providerRecovery.description',
            binding: { type: 'provider-recovery', provider },
            searchTerms: lower([
                'network error recovery',
                'timeout',
                'retry failed',
                'escape',
                'continue',
                ...providerTerms,
            ]),
        },
        ...(provider === 'claude'
            ? [
                  {
                      ...shared,
                      id: 'agents.claude.windows',
                      titleKey: 'settings.row.claudeWindows.title',
                      descriptionKey: 'settings.row.claudeWindows.description',
                      binding: { type: 'claude-windows' },
                      searchTerms: lower([
                          '5-hour windows',
                          'keep 5-hour windows rolling',
                          'first workday reset at',
                          'rate limit',
                          'usage limit',
                          'reset',
                          'warm-up',
                          'subscription',
                          ...providerTerms,
                      ]),
                  } satisfies SettingRowSource,
              ]
            : []),
        {
            ...shared,
            id: `agents.${provider}.skill`,
            titleKey: 'settings.row.providerSkill.title',
            descriptionKey: 'settings.row.providerSkill.description',
            binding: { type: 'provider-skill-health', provider },
            searchTerms: lower(['skill', 'cli', 'health', 'install', ...providerTerms]),
        },
        {
            ...shared,
            id: `agents.${provider}.executable`,
            advanced: true,
            titleKey: 'settings.row.providerExecutable.title',
            descriptionKey: 'settings.row.providerExecutable.description',
            binding: { type: 'provider-launch', provider, field: 'executable' },
            searchTerms: lower(['executable', 'command', 'launch', 'path', ...providerTerms]),
        },
        {
            ...shared,
            id: `agents.${provider}.autonomy`,
            titleKey: 'settings.row.providerAutonomy.title',
            descriptionKey: 'settings.row.providerAutonomy.description',
            binding: { type: 'provider-autonomy', provider },
            searchTerms: lower([
                'act without asking each time',
                'permission',
                'permissions',
                'approval',
                'approve',
                'ask',
                'confirm',
                'autonomy',
                'unattended',
                ...providerTerms,
            ]),
        },
        {
            ...shared,
            id: `agents.${provider}.args`,
            advanced: true,
            titleKey: 'settings.row.providerArgs.title',
            descriptionKey: 'settings.row.providerArgs.description',
            binding: { type: 'provider-launch', provider, field: 'args' },
            searchTerms: lower([
                'arguments',
                'args',
                'flags',
                'launch',
                'command line',
                ...providerTerms,
            ]),
        },
    ];
}
