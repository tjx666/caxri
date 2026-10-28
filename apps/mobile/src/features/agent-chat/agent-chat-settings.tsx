import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { AgentProvider } from '@caxri/protocol';
import { ShieldAlert, ShieldCheck } from 'lucide-react-native';

import { Chip } from '../../components/chip';
import { useTranslation } from '../../i18n';
import { mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { agentChatModelTrigger } from './agent-chat-model-choice';
import { agentChatPermissionTrigger } from './agent-chat-permission-choice';
import type { AgentChatSettingsEntry } from './agent-chat-settings-sheet';
import { AgentChatSettingsSheet } from './agent-chat-settings-sheet';
import { shouldMarkAgentChatPermission } from './agent-chat-settings-trigger';
import type { AgentChatController } from './use-agent-chat';
import {
    useAgentChatModelSelection,
    useAgentChatPermissionSelection,
} from './use-agent-chat-choice';

const styles = StyleSheet.create({
    modelSlot: { flexShrink: 1 },
    mode: { ...mobileType.meta, fontWeight: '600' },
});

/**
 * The Chat's settings entries above the composer input: one `Model · Effort` chip (followed by `Ultracode` while it is
 * on), and a shield chip while the permission level is worth noticing (`shouldMarkAgentChatPermission`), with `Plan`
 * beside it while plan mode is on. Both open the same Chat settings sheet, scrolled to their own section. A chip is
 * read-only while the device may not configure the Chat now (`control` access and a live connection), so the reader
 * still sees which model answers and at what level; an open sheet stays, disabled with the reason, when the connection
 * drops under the reader. The permission chip also shows whenever the model chip cannot, so permissions are never
 * unreachable.
 */
export const AgentChatSettings = ({
    chat,
    configureReason,
    permissionReason,
    provider,
    theme,
}: {
    chat: AgentChatController;
    /**
     * Why the device cannot configure the Chat now; see `agentChatDisabledReason` with `action: 'configure'`.
     */
    configureReason: string | undefined;
    /**
     * Why the device cannot change permissions now; see `agentChatDisabledReason` with `action: 'permission'`.
     */
    permissionReason: string | undefined;
    provider: AgentProvider | undefined;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [entry, setEntry] = useState<AgentChatSettingsEntry | null>(null);
    const model = useAgentChatModelSelection(chat, configureReason);
    const permission = useAgentChatPermissionSelection(chat, permissionReason);
    const modelTrigger = agentChatModelTrigger(model.snapshot, configureReason === undefined, t);
    const permissionTrigger = agentChatPermissionTrigger(
        permission.snapshot,
        provider,
        permissionReason === undefined,
        t,
    );
    const showsPermission =
        permissionTrigger !== undefined &&
        provider !== undefined &&
        (!modelTrigger ||
            shouldMarkAgentChatPermission({
                mode: permission.snapshot?.permissionMode,
                planMode: permissionTrigger.isPlanMode,
                provider,
            }));
    if (!modelTrigger && !showsPermission) return null;
    const hint = t('chat.settings.triggerHint');
    const PermissionIcon = permissionTrigger?.isFullAccess ? ShieldAlert : ShieldCheck;
    return (
        <>
            {modelTrigger ? (
                <View style={styles.modelSlot}>
                    <Chip
                        accessibilityHint={modelTrigger.isInteractive ? hint : undefined}
                        accessibilityLabel={modelTrigger.accessibilityLabel}
                        disabled={!modelTrigger.isInteractive}
                        label={
                            modelTrigger.effort
                                ? `${modelTrigger.model} · ${modelTrigger.effort}`
                                : modelTrigger.model
                        }
                        onPress={() => setEntry('model')}
                        testID={
                            modelTrigger.isInteractive
                                ? 'agent-chat-model-button'
                                : 'agent-chat-model-label'
                        }
                        theme={theme}
                        trailing={
                            modelTrigger.isUltracode ? (
                                <Text
                                    style={[styles.mode, { color: theme.text }]}
                                    testID="agent-chat-model-ultracode"
                                >
                                    Ultracode
                                </Text>
                            ) : null
                        }
                    />
                </View>
            ) : null}
            {showsPermission ? (
                <Chip
                    accessibilityHint={permissionTrigger.isInteractive ? hint : undefined}
                    accessibilityLabel={permissionTrigger.accessibilityLabel}
                    disabled={!permissionTrigger.isInteractive}
                    icon={PermissionIcon}
                    onPress={() => setEntry('permission')}
                    testID={
                        permissionTrigger.isInteractive
                            ? 'agent-chat-permission-button'
                            : 'agent-chat-permission-label'
                    }
                    theme={theme}
                    trailing={
                        permissionTrigger.isPlanMode ? (
                            <Text
                                style={[styles.mode, { color: theme.text }]}
                                testID="agent-chat-permission-plan"
                            >
                                {t('chat.permission.plan')}
                            </Text>
                        ) : null
                    }
                />
            ) : null}
            {entry ? (
                <AgentChatSettingsSheet
                    configureReason={configureReason}
                    entry={entry}
                    model={model}
                    onClose={() => setEntry(null)}
                    permission={permission}
                    permissionReason={permissionReason}
                    provider={provider}
                    theme={theme}
                />
            ) : null}
        </>
    );
};
