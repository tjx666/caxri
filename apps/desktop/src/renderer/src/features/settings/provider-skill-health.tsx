import type { AgentProvider, AgentSkillHealth } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import { writeToClipboardWithFeedback } from '../../components/copy-feedback';
import { CopyIconButton } from '../../components/markdown/copy-icon-button';
import { useTranslation } from '../../i18n';
import { textClipboard } from '../../lib/clipboard';
import { cn } from '../../lib/utilities';
import { skillScopeHealth, skillScopeSummary, skillScopeTone } from './provider-health';

const scopeToneClassName = {
    danger: 'text-danger',
    muted: 'text-muted',
    neutral: 'text-foreground',
    warning: 'text-warning',
} as const;

interface ProviderSkillHealthProperties {
    provider: AgentProvider;
    agentSkillHealth?: AgentSkillHealth;
}

/**
 * Read-only installation report for the bundled Caxri CLI skill: bundled version plus one block per scope with the
 * concrete repair command when an installation needs attention.
 */
export function ProviderSkillHealth({ provider, agentSkillHealth }: ProviderSkillHealthProperties) {
    const { t } = useTranslation();
    /**
     * The Server reports an installation for every scope of every provider Caxri installs skills for, so a loaded
     * report without this provider means the provider has no reviewed skill layout.
     */
    if (agentSkillHealth?.installations.every((installation) => installation.provider !== provider))
        return (
            <span className="text-muted">
                {t('settings.providerHealth.skill.unavailable', {
                    provider: agentProviderCatalog[provider].displayName,
                })}
            </span>
        );
    return (
        <div
            data-agent-skill-health={provider}
            className="rounded-sm border border-border p-2 text-[11px] text-muted"
        >
            <span className="flex items-center justify-between gap-3 text-foreground">
                <span>{t('settings.providerHealth.skill.bundle')}</span>
                <span className="font-mono text-[11px] text-muted">
                    {agentSkillHealth
                        ? t('settings.providerHealth.skill.bundledVersion', {
                              version: agentSkillHealth.bundled.bundledVersion,
                          })
                        : t('settings.providerHealth.skill.checkingBundle')}
                </span>
            </span>
            {(['local', 'global'] as const).map((scope) => {
                const installation = skillScopeHealth(agentSkillHealth, provider, scope);
                return (
                    <div
                        key={scope}
                        data-agent-skill-scope={scope}
                        className="mt-2 border-t border-border pt-2"
                    >
                        {/*
                         * An installation that needs attention says so in color, the same way the lifecycle-hook
                         * caption does. An absent one stays muted: the skill is optional, and its install command
                         * sits right beneath.
                         */}
                        <span
                            className={cn(
                                'block',
                                scopeToneClassName[skillScopeTone(installation)],
                            )}
                        >
                            {skillScopeSummary(t, agentSkillHealth, installation, scope)}
                        </span>
                        {installation && (
                            <span className="mt-0.5 block">{installation.action}</span>
                        )}
                        {installation?.repairCommand && (
                            <span className="mt-1 flex min-w-0 items-center gap-1">
                                <code className="block min-w-0 flex-1 overflow-x-auto font-mono text-[11px] text-foreground">
                                    {installation.repairCommand}
                                </code>
                                <CopyIconButton
                                    className="flex-none"
                                    label={t('settings.providerHealth.skill.copyCommand')}
                                    copy={() =>
                                        writeToClipboardWithFeedback(
                                            textClipboard,
                                            installation.repairCommand ?? '',
                                        )
                                    }
                                />
                            </span>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
