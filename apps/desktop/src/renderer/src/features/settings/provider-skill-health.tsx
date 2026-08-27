import type { AgentProvider, AgentSkillHealth } from '@caxri/protocol';

import { skillScopeHealth, skillScopeSummary } from './provider-health';

interface ProviderSkillHealthProperties {
    provider: AgentProvider;
    agentSkillHealth?: AgentSkillHealth;
}

/**
 * Read-only installation report for the bundled Caxri CLI skill: bundled version plus one block per scope with the
 * concrete repair command when an installation needs attention.
 */
export function ProviderSkillHealth({ provider, agentSkillHealth }: ProviderSkillHealthProperties) {
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
                        <span className="block text-foreground">
                            {skillScopeSummary(agentSkillHealth, installation, scope)}
                        </span>
                        {installation && (
                            <span className="mt-0.5 block">{installation.action}</span>
                        )}
                        {installation?.repairCommand && (
                            <code className="mt-1 block overflow-x-auto font-mono text-[10px] text-foreground">
                                {installation.repairCommand}
                            </code>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
