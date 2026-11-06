import type { AppSettings, DelegationType } from '@caxri/protocol';
import { agentProviderCatalog, DELEGATION_TYPES } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { AgentIdentityIcon } from '../../../icons/agents/agent-identity-icon';

type DelegationSettings = AppSettings['agents.delegation'];
type TypeBinding = NonNullable<DelegationSettings['types'][DelegationType]>;

/**
 * The tasks an Agent can ask for with `agent delegate create --type`, read-only: which Agent each runs on, from the
 * base `types` binding or the built-in default, followed by any caller's own binding. Bindings are edited in the
 * settings file; this list never writes settings itself.
 */
export function DelegationTypeList({ value }: { value: DelegationSettings }) {
    const { t } = useTranslation();
    const describe = (binding: TypeBinding) =>
        [
            agentProviderCatalog[binding.provider].displayName,
            binding.model ?? t('settings.delegationPresets.defaultModel'),
            binding.effort ?? t('settings.delegationPresets.defaultEffort'),
        ].join(' · ');
    return (
        <ul
            aria-label={t('settings.delegationTypes.title')}
            className="m-0 flex list-none flex-col gap-1 p-0"
        >
            {DELEGATION_TYPES.map((type) => {
                const base = value.types[type];
                const callers = Object.entries(value.callers).flatMap(([caller, rule]) => {
                    const binding = rule.types?.[type];
                    return binding ? [{ caller, binding }] : [];
                });
                return (
                    <li
                        key={type}
                        className="flex min-w-0 flex-col gap-0.5 rounded px-1 py-1 hover:bg-state-hover-quiet"
                        data-delegation-type={type}
                    >
                        <span className="flex min-w-0 items-center gap-2 text-[12px]">
                            <span className="shrink-0 text-foreground">
                                {t(`delegation.type.${type}`)}
                            </span>
                            <span className="shrink-0 font-mono text-[11px] text-muted">
                                {`--type ${type}`}
                            </span>
                            {base && <AgentIdentityIcon identity={base.provider} size={12} />}
                            <span className="min-w-0 truncate text-muted">
                                {base
                                    ? describe(base)
                                    : t(`settings.delegationTypes.default.${type}`)}
                            </span>
                        </span>
                        {callers.map(({ caller, binding }) => (
                            <span key={caller} className="truncate text-[11px] text-muted">
                                {t('settings.delegationTypes.caller', {
                                    caller: agentProviderCatalog[
                                        caller as keyof typeof agentProviderCatalog
                                    ].displayName,
                                    binding: describe(binding),
                                })}
                            </span>
                        ))}
                    </li>
                );
            })}
        </ul>
    );
}
