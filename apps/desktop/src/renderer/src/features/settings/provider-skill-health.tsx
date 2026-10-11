import type { AgentProvider, AgentSkillHealth } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import { writeToClipboardWithFeedback } from '../../components/copy-feedback';
import { CopyIconButton } from '../../components/markdown/copy-icon-button';
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
    if (!agentProviderCatalog[provider].capabilities.actions)
        return (
            <span className="text-muted">
                Bundled skills are unavailable for {agentProviderCatalog[provider].displayName}.
            </span>
        );
    return (
        <div
            data-agent-skill-health={provider}
            className="rounded-sm border border-border p-2 text-[11px] text-muted"
        >
            <span className="flex items-center justify-between gap-3 text-foreground">
                <span>Bundle</span>
                <span className="font-mono text-[10px] text-muted">
                    {agentSkillHealth
                        ? `Bundled v${agentSkillHealth.bundled.bundledVersion}`
                        : 'Checking bundle…'}
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
                            {skillScopeSummary(agentSkillHealth, installation, scope)}
                        </span>
                        {installation && (
                            <span className="mt-0.5 block">{installation.action}</span>
                        )}
                        {installation?.repairCommand && (
                            <span className="mt-1 flex min-w-0 items-center gap-1">
                                <code className="block min-w-0 flex-1 overflow-x-auto font-mono text-[10px] text-foreground">
                                    {installation.repairCommand}
                                </code>
                                <CopyIconButton
                                    className="flex-none"
                                    label="Copy command"
                                    copy={() =>
                                        writeToClipboardWithFeedback(
                                            navigator.clipboard,
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
