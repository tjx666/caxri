import { useState } from 'react';

import type { AgentActionOverride, AgentActionsSettings, AgentProvider } from '@caxri/protocol';
import {
    agentActionInvocationSchema,
    defaultAgentActions,
    MAX_AGENT_ACTION_DESCRIPTION_LENGTH,
    MAX_AGENT_ACTIONS,
} from '@caxri/protocol';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import { Tooltip } from '../../components/ui/tooltip';
import type { TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import { isImeComposing } from '../../lib/ime';

interface AgentActionSettingsEditorProperties {
    provider: AgentProvider;
    value: AgentActionsSettings;
    onChange: (value: AgentActionsSettings) => void;
}

/**
 * Example invocations are literal command syntax and stay untranslated; Grok has no actions, so its placeholder is a
 * translated word instead.
 */
const AGENT_ACTION_INVOCATION_PLACEHOLDERS: Record<
    AgentProvider,
    { text: string } | { key: TranslationKey }
> = {
    claude: { text: '/deploy' },
    codex: { text: '/goal or $commit' },
    grok: { key: 'settings.agentActionsEditor.unavailable' },
};

export function AgentActionSettingsEditor({
    provider,
    value,
    onChange,
}: AgentActionSettingsEditorProperties) {
    const { t } = useTranslation();
    const invocationPlaceholder = AGENT_ACTION_INVOCATION_PLACEHOLDERS[provider];
    const [invocationDraft, setInvocationDraft] = useState('');
    const [descriptionDraft, setDescriptionDraft] = useState('');
    const defaults = defaultAgentActions[provider];
    const defaultInvocations = new Set(defaults.map((action) => action.invocation));
    const overrideFor = (invocation: string): AgentActionOverride | undefined =>
        Object.hasOwn(value.items, invocation) ? value.items[invocation] : undefined;
    const defaultEntries = defaults.map((action) => ({
        action,
        override: overrideFor(action.invocation),
    }));
    const customInvocations = Object.keys(value.items)
        .filter((invocation) => !defaultInvocations.has(invocation))
        .toSorted((left, right) => left.localeCompare(right));
    const isAtCapacity = Object.keys(value.items).length >= MAX_AGENT_ACTIONS;
    const isValidDraft = agentActionInvocationSchema.safeParse(invocationDraft.trim()).success;
    const hasCapacity = Object.hasOwn(value.items, invocationDraft.trim()) || !isAtCapacity;

    const changeEnabled = (invocation: string, isEnabled: boolean): void => {
        const current = overrideFor(invocation);
        const items = { ...value.items };
        if (
            isEnabled &&
            defaultInvocations.has(invocation) &&
            !current?.description &&
            !current?.argumentHint
        )
            delete items[invocation];
        else items[invocation] = { ...current, enabled: isEnabled };
        onChange({ ...value, items });
    };

    const addAction = (): void => {
        const invocation = invocationDraft.trim();
        if (!hasCapacity || !agentActionInvocationSchema.safeParse(invocation).success) return;
        onChange({
            ...value,
            items: {
                ...value.items,
                [invocation]: {
                    enabled: true,
                    ...(descriptionDraft.trim() && { description: descriptionDraft.trim() }),
                },
            },
        });
        setInvocationDraft('');
        setDescriptionDraft('');
    };

    return (
        <div className="flex flex-col gap-2">
            <ul
                aria-label={t('settings.agentActionsEditor.listLabel', { provider })}
                className="m-0 flex list-none flex-col p-0"
            >
                {defaultEntries.map(({ action, override }) => (
                    <li
                        key={action.invocation}
                        className="flex min-h-9 items-center gap-2 rounded px-1"
                    >
                        <code className="w-24 shrink-0 font-mono text-[12px] text-foreground">
                            {action.invocation}
                        </code>
                        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
                            {override?.description ?? action.description}
                        </span>
                        <small className="text-[10px] text-muted">
                            {t('settings.agentActionsEditor.builtIn')}
                        </small>
                        <Switch
                            aria-label={t('settings.agentActionsEditor.show', {
                                invocation: action.invocation,
                            })}
                            checked={override?.enabled ?? true}
                            disabled={!override && isAtCapacity}
                            onCheckedChange={(checked) => changeEnabled(action.invocation, checked)}
                        />
                    </li>
                ))}
                {customInvocations.map((invocation) => (
                    <li
                        key={invocation}
                        className="group/action flex min-h-9 items-center gap-2 rounded px-1"
                    >
                        <code className="w-24 shrink-0 truncate font-mono text-[12px] text-foreground">
                            {invocation}
                        </code>
                        <Input
                            aria-label={t('settings.agentActionsEditor.descriptionFor', {
                                invocation,
                            })}
                            className="min-w-0 flex-1 bg-background"
                            maxLength={MAX_AGENT_ACTION_DESCRIPTION_LENGTH}
                            placeholder={t('settings.agentActionsEditor.optionalDescription')}
                            size="dense"
                            value={value.items[invocation].description ?? ''}
                            onChange={(event) =>
                                onChange({
                                    ...value,
                                    items: {
                                        ...value.items,
                                        [invocation]: {
                                            ...value.items[invocation],
                                            description: event.target.value || undefined,
                                        },
                                    },
                                })
                            }
                        />
                        <Tooltip content={t('settings.agentActionsEditor.remove')}>
                            <Button
                                aria-label={t('settings.agentActionsEditor.removeNamed', {
                                    invocation,
                                })}
                                className="opacity-0 group-focus-within/action:opacity-100 group-hover/action:opacity-100"
                                size="icon"
                                variant="ghost"
                                onClick={() => {
                                    const items = { ...value.items };
                                    delete items[invocation];
                                    onChange({ ...value, items });
                                }}
                            >
                                <Trash2 size={13} />
                            </Button>
                        </Tooltip>
                        <Switch
                            aria-label={t('settings.agentActionsEditor.show', { invocation })}
                            checked={value.items[invocation].enabled}
                            onCheckedChange={(checked) => changeEnabled(invocation, checked)}
                        />
                    </li>
                ))}
            </ul>
            <div className="grid grid-cols-[minmax(110px,0.55fr)_minmax(160px,1fr)_auto] items-center gap-2">
                <Input
                    aria-label={t('settings.agentActionsEditor.newInvocation')}
                    className="bg-background font-mono"
                    placeholder={
                        'key' in invocationPlaceholder
                            ? t(invocationPlaceholder.key)
                            : invocationPlaceholder.text
                    }
                    size="dense"
                    value={invocationDraft}
                    onChange={(event) => setInvocationDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && !isImeComposing(event)) addAction();
                    }}
                />
                <Input
                    aria-label={t('settings.agentActionsEditor.newDescription')}
                    className="bg-background"
                    maxLength={MAX_AGENT_ACTION_DESCRIPTION_LENGTH}
                    placeholder={t('settings.agentActionsEditor.optionalDescription')}
                    size="dense"
                    value={descriptionDraft}
                    onChange={(event) => setDescriptionDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && !isImeComposing(event)) addAction();
                    }}
                />
                <Button
                    aria-label={t('settings.agentActionsEditor.add')}
                    disabled={!isValidDraft || !hasCapacity}
                    size="sm"
                    variant="secondary"
                    onClick={addAction}
                >
                    <Plus size={13} /> {t('common.add')}
                </Button>
            </div>
            {invocationDraft.trim() && !isValidDraft && (
                <p className="m-0 text-[11px] text-danger" role="status">
                    {t('settings.agentActionsEditor.invalidInvocation')}
                </p>
            )}
            {isValidDraft && !hasCapacity && (
                <p className="m-0 text-[11px] text-danger" role="status">
                    {t('settings.agentActionsEditor.atCapacity')}
                </p>
            )}
        </div>
    );
}
