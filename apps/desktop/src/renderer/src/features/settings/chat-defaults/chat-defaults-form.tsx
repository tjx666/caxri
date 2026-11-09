import { useState } from 'react';

import type { AgentChatDefaults, AgentChatDefaultsProvider } from '@caxri/protocol';
import { agentChatEffortLabel, agentProviderCatalog } from '@caxri/protocol';

import { Button } from '../../../components/ui/button';
import { FieldDescription } from '../../../components/ui/field';
import { Spinner } from '../../../components/ui/spinner';
import { Switch } from '../../../components/ui/switch';
import { useTranslation } from '../../../i18n';
import { useCaxriQuery } from '../../../queries/client';
import { ChatDefaultField } from './chat-default-field';
import { writeChatDefaults } from './chat-defaults-client';
import {
    chatDefaultEffortOptions,
    chatDefaultModelChange,
    chatDefaultModelOptions,
    chatDefaultModelValue,
    chatDefaultOverrideText,
} from './chat-defaults-options';

/**
 * Settings › Agents › Default model for one Agent: the model, reasoning effort, and (Claude Code) ultracode that new
 * Chats start with and a Chat's Reset to default returns to. The values live in the Agent's own config file, so each
 * read is fresh (`staleTime: 0`): the Agent's own `/model` may have changed the file since.
 */
export function ChatDefaultsForm({ provider }: { provider: AgentChatDefaultsProvider }) {
    const { t } = useTranslation();
    const providerName = agentProviderCatalog[provider].displayName;
    const query = useCaxriQuery('agentChat.readDefaults', { provider }, { staleTime: 0 });
    if (!query.data && query.isError)
        return (
            <div className="grid min-h-16 content-center justify-items-start gap-2" role="alert">
                <p className="m-0 text-[12px] text-danger">
                    {t('settings.chatDefaults.loadFailed', { provider: providerName })}
                </p>
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                        void query.refetch();
                    }}
                >
                    {t('common.retry')}
                </Button>
            </div>
        );
    if (!query.data)
        return (
            <div className="flex min-h-16 items-center gap-2 text-[12px] text-muted" role="status">
                <Spinner aria-hidden="true" size={13} style={{ width: 13, height: 13 }} />
                {t('settings.chatDefaults.loading', { provider: providerName })}
            </div>
        );
    return <ChatDefaultsFields defaults={query.data} providerName={providerName} />;
}

function ChatDefaultsFields({
    defaults,
    providerName,
}: {
    defaults: AgentChatDefaults;
    providerName: string;
}) {
    const { t } = useTranslation();
    const [isSaving, setSaving] = useState(false);
    const { provider } = defaults;
    const save = (change: Parameters<typeof writeChatDefaults>[1]): void => {
        setSaving(true);
        void writeChatDefaults(provider, change).finally(() => setSaving(false));
    };
    const efforts = chatDefaultEffortOptions(defaults);
    const ultracodeOverride = chatDefaultOverrideText(t, defaults.overrides, 'ultracode');
    return (
        <div className="grid w-full gap-3" data-testid={`chat-defaults-${provider}`}>
            <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                <ChatDefaultField
                    disabled={isSaving}
                    id={`chat-defaults-${provider}-model`}
                    label={t('settings.chatDefaults.model')}
                    options={
                        defaults.models.length > 0 ? chatDefaultModelOptions(defaults) : undefined
                    }
                    override={chatDefaultOverrideText(t, defaults.overrides, 'model')}
                    unsetLabel={t('settings.chatDefaults.agentModel', { provider: providerName })}
                    value={chatDefaultModelValue(defaults)}
                    onChange={(model) => save(chatDefaultModelChange(defaults, model))}
                />
                <ChatDefaultField
                    disabled={isSaving}
                    id={`chat-defaults-${provider}-effort`}
                    label={t('settings.chatDefaults.effort')}
                    options={efforts?.map((effort) => ({
                        value: effort,
                        label: agentChatEffortLabel(effort, t),
                    }))}
                    override={chatDefaultOverrideText(t, defaults.overrides, 'effort')}
                    unsetLabel={t('settings.chatDefaults.modelEffort')}
                    value={defaults.effort}
                    onChange={(effort) => save({ effort })}
                />
            </div>
            {provider === 'claude' && (
                <div className="grid gap-1">
                    <label className="flex items-start gap-2.5">
                        <Switch
                            checked={defaults.ultracode === true}
                            className="mt-0.5"
                            disabled={isSaving}
                            onCheckedChange={(isOn) => save({ ultracode: isOn ? true : null })}
                        />
                        <span className="grid gap-0.5">
                            <span className="text-[12px] text-foreground">
                                {t('settings.chatDefaults.ultracode')}
                            </span>
                            <FieldDescription>
                                {t('settings.chatDefaults.ultracodeDescription')}
                            </FieldDescription>
                        </span>
                    </label>
                    {ultracodeOverride && (
                        <FieldDescription role="note" tone="warning">
                            {ultracodeOverride}
                        </FieldDescription>
                    )}
                </div>
            )}
            <FieldDescription>
                {defaults.models.length === 0 &&
                    `${t('settings.chatDefaults.noModels', { provider: providerName })} `}
                {t('settings.chatDefaults.file', { file: defaults.file, provider: providerName })}
            </FieldDescription>
        </div>
    );
}
