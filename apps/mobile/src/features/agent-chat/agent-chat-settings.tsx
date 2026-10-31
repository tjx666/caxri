import { StyleSheet, Text, View } from 'react-native';

import type { AgentProvider } from '@caxri/protocol';
import { ShieldAlert, ShieldCheck } from 'lucide-react-native';

import { Chip } from '../../components/chip';
import { useTranslation } from '../../i18n';
import { mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import type { AgentChatModelTrigger } from './agent-chat-model-choice';
import { agentChatModelTrigger } from './agent-chat-model-choice';
import type { AgentChatPermissionTrigger } from './agent-chat-permission-choice';
import { agentChatPermissionTrigger } from './agent-chat-permission-choice';
import type { AgentChatSettingsEntry } from './agent-chat-settings-sheet';
import { AgentChatSettingsSheet } from './agent-chat-settings-sheet';
import { visibleAgentChatPermissionTrigger } from './agent-chat-settings-trigger';
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
 * The `Model · Effort` chip, with `Ultracode` trailing while it is on; split out of `AgentChatSettings` to keep its
 * control flow flat (react-doctor/no-high-complexity-react-function).
 */
const ModelChip = ({
    hint,
    onPress,
    theme,
    trigger,
}: {
    hint: string;
    onPress: () => void;
    theme: MobileTheme;
    trigger: AgentChatModelTrigger;
}) => (
    <View style={styles.modelSlot}>
        <Chip
            accessibilityHint={trigger.isInteractive ? hint : undefined}
            accessibilityLabel={trigger.accessibilityLabel}
            disabled={!trigger.isInteractive}
            label={trigger.effort ? `${trigger.model} · ${trigger.effort}` : trigger.model}
            onPress={onPress}
            testID={trigger.isInteractive ? 'agent-chat-model-button' : 'agent-chat-model-label'}
            theme={theme}
            trailing={
                trigger.isUltracode ? (
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
);

/**
 * The shield chip, with `Plan` trailing while plan mode is on; split out of `AgentChatSettings` like `ModelChip`.
 */
const PermissionChip = ({
    hint,
    onPress,
    theme,
    trigger,
}: {
    hint: string;
    onPress: () => void;
    theme: MobileTheme;
    trigger: AgentChatPermissionTrigger;
}) => {
    const { t } = useTranslation();
    return (
        <Chip
            accessibilityHint={trigger.isInteractive ? hint : undefined}
            accessibilityLabel={trigger.accessibilityLabel}
            disabled={!trigger.isInteractive}
            icon={trigger.isFullAccess ? ShieldAlert : ShieldCheck}
            onPress={onPress}
            testID={
                trigger.isInteractive
                    ? 'agent-chat-permission-button'
                    : 'agent-chat-permission-label'
            }
            theme={theme}
            trailing={
                trigger.isPlanMode ? (
                    <Text
                        style={[styles.mode, { color: theme.text }]}
                        testID="agent-chat-permission-plan"
                    >
                        {t('chat.permission.plan')}
                    </Text>
                ) : null
            }
        />
    );
};

/**
 * The Chat's settings entries above the composer input: one `Model · Effort` chip (followed by `Ultracode` while it is
 * on), and a shield chip while the permission level is worth noticing (`shouldMarkAgentChatPermission`), with `Plan`
 * beside it while plan mode is on. Both open the same Chat settings sheet, scrolled to their own section; the composer
 * owns which one is open (`entry`), so `/model` opens it too. A chip is read-only while the device may not configure
 * the Chat now (`control` access and a live connection), so the reader still sees which model answers and at what
 * level; an open sheet stays, disabled with the reason, when the connection drops under the reader. The permission chip
 * also shows whenever the model chip cannot, so permissions are never unreachable.
 */
export const AgentChatSettings = ({
    chat,
    configureReason,
    entry,
    onEntryChange,
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
     * The section the open settings sheet shows, or `null` while it is closed.
     */
    entry: AgentChatSettingsEntry | null;
    onEntryChange: (entry: AgentChatSettingsEntry | null) => void;
    /**
     * Why the device cannot change permissions now; see `agentChatDisabledReason` with `action: 'permission'`.
     */
    permissionReason: string | undefined;
    provider: AgentProvider | undefined;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const model = useAgentChatModelSelection(chat, configureReason);
    const permission = useAgentChatPermissionSelection(chat, permissionReason);
    const modelTrigger = agentChatModelTrigger(model.snapshot, configureReason === undefined, t);
    const permissionTrigger = agentChatPermissionTrigger(
        permission.snapshot,
        provider,
        permissionReason === undefined,
        t,
    );
    const permissionChip = visibleAgentChatPermissionTrigger({
        hasModelTrigger: modelTrigger !== undefined,
        mode: permission.snapshot?.permissionMode,
        provider,
        trigger: permissionTrigger,
    });
    if (!modelTrigger && !permissionChip) return null;
    const hint = t('chat.settings.triggerHint');
    return (
        <>
            {modelTrigger ? (
                <ModelChip
                    hint={hint}
                    onPress={() => onEntryChange('model')}
                    theme={theme}
                    trigger={modelTrigger}
                />
            ) : null}
            {permissionChip ? (
                <PermissionChip
                    hint={hint}
                    onPress={() => onEntryChange('permission')}
                    theme={theme}
                    trigger={permissionChip}
                />
            ) : null}
            {entry ? (
                <AgentChatSettingsSheet
                    configureReason={configureReason}
                    entry={entry}
                    model={model}
                    onClose={() => onEntryChange(null)}
                    permission={permission}
                    permissionReason={permissionReason}
                    provider={provider}
                    theme={theme}
                />
            ) : null}
        </>
    );
};
