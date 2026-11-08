import { useState } from 'react';

import type { AgentProvider, AppSettings, DelegationType } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';
import { ChevronRight, X } from 'lucide-react';

import { Button } from '../../../../components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../../../components/ui/select';
import { FOCUSABLE_TOOLTIP_TRIGGER_CLASS, Tooltip } from '../../../../components/ui/tooltip';
import { useTranslation } from '../../../../i18n';
import { AgentIdentityIcon } from '../../../../icons/agents/agent-identity-icon';
import type { TypeBinding } from './binding';
import { resolveTypeBinding, setTypeBinding } from './binding';
import { BindingControls } from './binding-controls';

type DelegationSettings = AppSettings['agents.delegation'];

/**
 * Select item value of the "Add override" picker's placeholder.
 */
const ADD_PLACEHOLDER = '__add__';

/**
 * Words one binding for the collapsed summary, e.g. `Codex · gpt-5.5 · high`.
 */
function useDescribeBinding() {
    const { t } = useTranslation();
    return (binding: TypeBinding) =>
        [
            agentProviderCatalog[binding.provider].displayName,
            binding.model ?? t('settings.delegationPresets.defaultModel'),
            binding.effort ?? t('settings.delegationPresets.defaultEffort'),
        ].join(' · ');
}

interface TypeRowProperties {
    type: DelegationType;
    value: DelegationSettings;
    onChange: (value: DelegationSettings, member: string) => void;
}

/**
 * One delegation type: its base binding as editable controls, then a collapsed area for the calling Agents that run it
 * on something else. Collapsed, the area shows each override as one summary line. Every edit hands the whole setting
 * back through {@link setTypeBinding}, so presets and every other field survive.
 */
export function TypeRow({ type, value, onChange }: TypeRowProperties) {
    const { t } = useTranslation();
    const describe = useDescribeBinding();
    const [isExpanded, setIsExpanded] = useState(false);
    const base = value.types[type];
    const typeName = t(`delegation.type.${type}`);
    const overrides = agentProviderIds.flatMap((caller) => {
        const binding = value.callers[caller]?.types?.[type];
        return binding ? [{ caller, binding }] : [];
    });
    const addable = agentProviderIds.filter((caller) => !value.callers[caller]?.types?.[type]);
    const callerName = (caller: AgentProvider) => agentProviderCatalog[caller].displayName;
    return (
        <li
            className="flex min-w-0 flex-col gap-1 rounded px-1 py-1 hover:bg-state-hover-quiet"
            data-delegation-type={type}
        >
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="flex min-w-0 items-center gap-2 text-[12px]">
                    <Tooltip content={t('settings.delegationTypes.cliFlag', { type })}>
                        <span
                            className={`shrink-0 text-foreground ${FOCUSABLE_TOOLTIP_TRIGGER_CLASS}`}
                            tabIndex={0}
                        >
                            {typeName}
                        </span>
                    </Tooltip>
                </span>
                <div className="w-full max-w-[28rem] min-w-64 flex-1">
                    <BindingControls
                        label={typeName}
                        binding={base}
                        defaultBinding={resolveTypeBinding(type, undefined, undefined)}
                        noneLabel={t('settings.delegationTypes.useDefault')}
                        onChange={(binding) =>
                            onChange(setTypeBinding(value, type, {}, binding), 'types')
                        }
                    />
                </div>
            </div>
            {!base && (
                <span className="truncate text-[11px] text-muted">
                    {t(`settings.delegationTypes.default.${type}`)}
                </span>
            )}
            <button
                aria-expanded={isExpanded}
                className="flex w-fit cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[11px] text-muted outline-none hover:text-foreground focus-visible:text-foreground"
                type="button"
                onClick={() => setIsExpanded((current) => !current)}
            >
                <ChevronRight
                    aria-hidden="true"
                    className={isExpanded ? 'rotate-90' : undefined}
                    size={12}
                />
                {t('settings.delegationTypes.byCaller')}
                {overrides.length > 0 && ` (${overrides.length})`}
            </button>
            {!isExpanded &&
                overrides.map(({ caller, binding }) => (
                    <span key={caller} className="truncate pl-4 text-[11px] text-muted">
                        {t('settings.delegationTypes.caller', {
                            caller: callerName(caller),
                            binding: describe(binding),
                        })}
                    </span>
                ))}
            {isExpanded && (
                <div className="flex min-w-0 flex-col gap-1 pl-4">
                    {overrides.map(({ caller, binding }) => (
                        <div
                            key={caller}
                            className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1"
                        >
                            <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted">
                                <AgentIdentityIcon identity={caller} size={12} />
                                {t('settings.delegationTypes.whenAsks', {
                                    caller: callerName(caller),
                                })}
                            </span>
                            <div className="flex w-full max-w-[28rem] min-w-64 flex-1 items-center gap-1">
                                <div className="min-w-0 flex-1">
                                    <BindingControls
                                        label={t('settings.delegationTypes.overrideLabel', {
                                            name: typeName,
                                            caller: callerName(caller),
                                        })}
                                        binding={binding}
                                        noneLabel={t('settings.delegationTypes.sameAsBase')}
                                        onChange={(next) =>
                                            onChange(
                                                setTypeBinding(value, type, { caller }, next),
                                                'callers',
                                            )
                                        }
                                    />
                                </div>
                                <Button
                                    aria-label={t('settings.delegationTypes.removeOverride', {
                                        name: typeName,
                                        caller: callerName(caller),
                                    })}
                                    size="icon"
                                    variant="ghost"
                                    onClick={() =>
                                        onChange(
                                            setTypeBinding(value, type, { caller }, undefined),
                                            'callers',
                                        )
                                    }
                                >
                                    <X aria-hidden="true" size={12} />
                                </Button>
                            </div>
                        </div>
                    ))}
                    {addable.length > 0 && (
                        <Select
                            value={ADD_PLACEHOLDER}
                            onValueChange={(next) => {
                                if (next === null || next === ADD_PLACEHOLDER) return;
                                const caller = next as AgentProvider;
                                onChange(
                                    setTypeBinding(
                                        value,
                                        type,
                                        { caller },
                                        resolveTypeBinding(type, base, caller),
                                    ),
                                    'callers',
                                );
                            }}
                        >
                            <SelectTrigger
                                aria-label={t('settings.delegationTypes.addOverrideLabel', {
                                    name: typeName,
                                })}
                                className="h-7 w-fit gap-1.5 bg-background px-2 text-[12px] text-muted"
                            >
                                <SelectValue>
                                    {t('settings.delegationTypes.addOverride')}
                                </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                                {addable.map((caller) => (
                                    <SelectItem key={caller} value={caller}>
                                        <span className="flex items-center gap-1.5">
                                            <AgentIdentityIcon identity={caller} size={12} />
                                            {t('settings.delegationTypes.whenAsks', {
                                                caller: callerName(caller),
                                            })}
                                        </span>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    )}
                </div>
            )}
        </li>
    );
}
