import type { AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';

import { Input } from '../../../../components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../../../components/ui/select';
import { useTranslation } from '../../../../i18n';
import { AgentIdentityIcon } from '../../../../icons/agents/agent-identity-icon';
import type { TypeBinding } from './binding';
import {
    changeBindingEffort,
    changeBindingModel,
    changeBindingProvider,
    supportedEfforts,
} from './binding';

/**
 * Select item value standing for "no binding" (Agent) or "no choice" (effort); Base UI items need a non-null value.
 */
const NONE = '__none__';
const TRIGGER_CLASS_NAME = 'h-7 min-w-0 flex-1 bg-background px-2 text-[12px]';

interface BindingControlsProperties {
    /**
     * Names the three controls for assistive technology, e.g. `Review` or `Review, when Claude asks`.
     */
    label: string;
    binding: TypeBinding | undefined;
    /**
     * Wording of the Agent choice that removes the binding: the built-in default for a base binding, the base binding
     * for a caller override.
     */
    noneLabel: string;
    /**
     * Receives the next binding, or `undefined` when the user chose {@link noneLabel}.
     */
    onChange: (binding: TypeBinding | undefined) => void;
}

/**
 * The Agent, model and effort of one binding as three compact controls. Without a binding the model and effort are
 * disabled, because they only refine an Agent. Each change goes through the pure helpers that keep the binding valid.
 */
export function BindingControls({
    label,
    binding,
    noneLabel,
    onChange,
}: BindingControlsProperties) {
    const { t } = useTranslation();
    const providerLabel = (provider: AgentProvider | undefined) =>
        provider === undefined ? noneLabel : agentProviderCatalog[provider].displayName;
    const efforts = binding ? supportedEfforts(binding.provider, binding.model) : [];
    return (
        <div className="flex min-w-0 items-center gap-1.5">
            <Select
                value={binding?.provider ?? NONE}
                onValueChange={(next) => {
                    if (next === null) return;
                    onChange(
                        next === NONE
                            ? undefined
                            : changeBindingProvider(binding, next as AgentProvider),
                    );
                }}
            >
                <SelectTrigger
                    aria-label={t('settings.delegationTypes.agentLabel', { name: label })}
                    className={TRIGGER_CLASS_NAME}
                >
                    <SelectValue>
                        <span className="flex items-center gap-1.5">
                            {binding && <AgentIdentityIcon identity={binding.provider} size={12} />}
                            {providerLabel(binding?.provider)}
                        </span>
                    </SelectValue>
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value={NONE}>{noneLabel}</SelectItem>
                    {agentProviderIds.map((provider) => (
                        <SelectItem key={provider} value={provider}>
                            <span className="flex items-center gap-1.5">
                                <AgentIdentityIcon identity={provider} size={12} />
                                {providerLabel(provider)}
                            </span>
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {/* Keyed by the stored model so an Agent change, which clears it, also clears the draft text. */}
            <Input
                key={`${binding?.provider}:${binding?.model ?? ''}`}
                aria-label={t('settings.delegationTypes.modelLabel', { name: label })}
                appearance="workbench"
                className="min-w-0 flex-1"
                defaultValue={binding?.model ?? ''}
                disabled={!binding}
                placeholder={t('settings.delegationPresets.defaultModel')}
                size="dense"
                spellCheck={false}
                onBlur={(event) => {
                    if (binding && event.currentTarget.value.trim() !== (binding.model ?? ''))
                        onChange(changeBindingModel(binding, event.currentTarget.value));
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                }}
            />
            <Select
                value={binding?.effort ?? NONE}
                disabled={!binding}
                onValueChange={(next) => {
                    if (next === null || !binding) return;
                    onChange(
                        changeBindingEffort(
                            binding,
                            next === NONE ? undefined : (next as TypeBinding['effort']),
                        ),
                    );
                }}
            >
                <SelectTrigger
                    aria-label={t('settings.delegationTypes.effortLabel', { name: label })}
                    className={TRIGGER_CLASS_NAME}
                >
                    <SelectValue>
                        {binding?.effort ?? t('settings.delegationPresets.defaultEffort')}
                    </SelectValue>
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value={NONE}>
                        {t('settings.delegationPresets.defaultEffort')}
                    </SelectItem>
                    {efforts.map((effort) => (
                        <SelectItem key={effort} value={effort}>
                            {effort}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}
