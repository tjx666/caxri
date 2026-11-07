import { StyleSheet, Text, View } from 'react-native';

import { ShieldAlert, ShieldCheck } from 'lucide-react-native';

import { Chip } from '../../components/chip';
import { useTranslation } from '../../i18n';
import { mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import type { AgentChatModelTrigger } from './agent-chat-model-choice';
import type { AgentChatPermissionTrigger } from './agent-chat-permission-choice';
import {
    AgentChatSessionUsageButton,
    AgentChatSessionUsageSheet,
} from './agent-chat-session-usage-sheet';
import type { AgentChatSettingsEntry } from './agent-chat-settings-sheet';
import { AgentChatSettingsSheet } from './agent-chat-settings-sheet';
import type { AgentChatController } from './use-agent-chat';
import type { AgentChatComposerSheet } from './use-agent-chat-app-commands';
import type { AgentChatSettingsState } from './use-agent-chat-settings';

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
 * The Chat's settings entries in the expanded composer capsule: one `Model · Effort` chip (followed by `Ultracode`
 * while it is on), and a shield chip while the permission level is worth noticing (`shouldMarkAgentChatPermission`),
 * with `Plan` beside it while plan mode is on. Both open the same Chat settings sheet (`AgentChatSettingsPanel`),
 * scrolled to their own section. A chip is read-only while the device may not configure the Chat now (`control` access
 * and a live connection), so the reader still sees which model answers and at what level. The permission chip also
 * shows whenever the model chip cannot, so permissions are never unreachable.
 */
const AgentChatSettingsChips = ({
    onOpen,
    settings,
    theme,
}: {
    onOpen: (entry: AgentChatSettingsEntry) => void;
    settings: AgentChatSettingsState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { modelTrigger, permissionChip } = settings;
    const hint = t('chat.settings.triggerHint');
    return (
        <>
            {modelTrigger ? (
                <ModelChip
                    hint={hint}
                    onPress={() => onOpen('model')}
                    theme={theme}
                    trigger={modelTrigger}
                />
            ) : null}
            {permissionChip ? (
                <PermissionChip
                    hint={hint}
                    onPress={() => onOpen('permission')}
                    theme={theme}
                    trigger={permissionChip}
                />
            ) : null}
        </>
    );
};

/**
 * The open Chat settings sheet, or nothing while `entry` is `null`. The composer owns which section is open, so the
 * chips, `/model`, and the add sheet's rows all open the same sheet, and it renders apart from the chips: the chips
 * come and go with the capsule's layout, and the open sheet must not remount under the reader when they do. An open
 * sheet stays, disabled with the reason, when the connection drops under the reader.
 */
const AgentChatSettingsPanel = ({
    entry,
    onClose,
    settings,
    theme,
}: {
    entry: AgentChatSettingsEntry | null;
    onClose: () => void;
    settings: AgentChatSettingsState;
    theme: MobileTheme;
}) =>
    entry ? (
        <AgentChatSettingsSheet
            configureReason={settings.configureReason}
            entry={entry}
            model={settings.model}
            onClose={onClose}
            permission={settings.permission}
            permissionReason={settings.permissionReason}
            provider={settings.provider}
            theme={theme}
        />
    ) : null;

/**
 * The expanded capsule's settings row: the Model and Permission chips, then Usage once the Chat has a Terminal.
 */
export const AgentChatSettingsRow = ({
    chat,
    onOpen,
    settings,
    theme,
}: {
    chat: AgentChatController;
    onOpen: (sheet: AgentChatComposerSheet) => void;
    settings: AgentChatSettingsState;
    theme: MobileTheme;
}) => (
    <>
        <AgentChatSettingsChips onOpen={onOpen} settings={settings} theme={theme} />
        {chat.snapshot?.terminalId ? (
            <AgentChatSessionUsageButton
                onOpen={() => onOpen('usage')}
                terminalId={chat.snapshot.terminalId}
                theme={theme}
                usage={chat.snapshot.usage}
            />
        ) : null}
    </>
);

/**
 * The composer's open sheet: Chat settings at its section, or Usage for the Chat's Terminal. Like the settings sheet,
 * it renders apart from the row that opens it, so the Add to Chat sheet's rows open it while the capsule is folded.
 */
export const AgentChatSettingsSheets = ({
    chat,
    onClose,
    settings,
    sheet,
    theme,
}: {
    chat: AgentChatController;
    onClose: () => void;
    settings: AgentChatSettingsState;
    sheet: AgentChatComposerSheet | null;
    theme: MobileTheme;
}) => (
    <>
        <AgentChatSettingsPanel
            entry={sheet === 'usage' ? null : sheet}
            onClose={onClose}
            settings={settings}
            theme={theme}
        />
        {sheet === 'usage' && chat.snapshot?.terminalId ? (
            <AgentChatSessionUsageSheet
                onClose={onClose}
                terminalId={chat.snapshot.terminalId}
                theme={theme}
                usage={chat.snapshot.usage}
            />
        ) : null}
    </>
);
