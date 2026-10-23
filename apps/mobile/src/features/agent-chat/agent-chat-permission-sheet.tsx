import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { AgentChatPermissionMode, AgentProvider } from '@caxri/protocol';
import { ChevronDown, ShieldAlert, ShieldCheck } from 'lucide-react-native';

import { BottomSheet, SheetCancel } from '../../components/bottom-sheet';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import {
    agentChatPermissionOptions,
    agentChatPermissionSheetNote,
    agentChatPermissionTrigger,
    agentChatPlanModeToggle,
} from './agent-chat-permission-choice';
import {
    SheetMessages,
    SheetOptionRow,
    SheetSectionLabel,
    SheetToggleRow,
} from './agent-chat-sheet-primitives';
import { sheetStyles, TRIGGER_HIT_SLOP } from './agent-chat-sheet-styles';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatPermissionSelection } from './use-agent-chat-choice';

type PermissionSelection = ReturnType<typeof useAgentChatPermissionSelection>;

/**
 * The Desktop composer's permission menu as a phone sheet: the provider's levels with what each means, and, for a
 * provider with one, the Plan mode switch. Choosing a level applies it on tap and closes the sheet; toggling plan mode
 * keeps it open, as on Desktop. Desktop's "Use as Project default" is not offered: Project defaults stay a Desktop
 * setting.
 */
const AgentChatPermissionSheet = ({
    disabledReason,
    onClose,
    provider,
    selection,
    theme,
}: {
    disabledReason: string | undefined;
    onClose: () => void;
    provider: AgentProvider;
    selection: PermissionSelection;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { busy, error, snapshot } = selection;
    const options = agentChatPermissionOptions(snapshot, provider, t);
    const planMode = agentChatPlanModeToggle(snapshot, provider, t);
    const isDisabled = busy !== null || disabledReason !== undefined;
    return (
        <BottomSheet
            closeLabel={t('chat.permission.close')}
            maxHeight="80%"
            onClose={onClose}
            testID="agent-chat-permission-sheet"
            theme={theme}
        >
            {(dismiss) => {
                const chooseLevel = async (permissionMode: AgentChatPermissionMode) => {
                    // A failure keeps the sheet open on its error; a success finishes the choice.
                    if (await selection.didConfigure({ permissionMode })) dismiss();
                };
                return (
                    <>
                        <ScrollView style={sheetStyles.scroll}>
                            <SheetSectionLabel
                                label={t('chat.permission.permissions')}
                                theme={theme}
                            />
                            {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- A provider offers at most five levels. */}
                            {options.map((option) => (
                                <SheetOptionRow
                                    description={option.description}
                                    isBusy={
                                        option.value !== 'custom' &&
                                        busy?.permissionMode === option.value
                                    }
                                    isDisabled={isDisabled}
                                    isSelected={option.isSelected}
                                    key={option.value}
                                    label={option.label}
                                    labelColor={option.isFullAccess ? theme.warning : undefined}
                                    onPress={() => {
                                        // Custom only explains the launch settings; there is nothing to switch back to.
                                        if (option.value === 'custom' || option.isSelected) return;
                                        void chooseLevel(option.value);
                                    }}
                                    testID={option.testID}
                                    theme={theme}
                                />
                            ))}
                            {planMode ? (
                                <SheetToggleRow
                                    description={planMode.description}
                                    isBusy={busy?.planMode !== undefined}
                                    isDisabled={isDisabled}
                                    isOn={planMode.isOn}
                                    label={planMode.label}
                                    onToggle={(isOn) => {
                                        void selection.didConfigure({ planMode: isOn });
                                    }}
                                    testID="agent-chat-plan-mode"
                                    theme={theme}
                                />
                            ) : null}
                        </ScrollView>
                        <SheetMessages
                            disabledReason={disabledReason}
                            error={error}
                            note={agentChatPermissionSheetNote(snapshot, provider, t)}
                            testIDPrefix="agent-chat-permission"
                            theme={theme}
                        />
                        <SheetCancel
                            label="Done"
                            onPress={dismiss}
                            testID="agent-chat-permission-done"
                            theme={theme}
                        />
                    </>
                );
            }}
        </BottomSheet>
    );
};

/**
 * The Chat's permission level and plan mode above the composer input, beside the model as Desktop keeps them. Full
 * access carries the warning shield and tone. It opens the sheet only when the device may change permissions now
 * (`control` access and a live connection); otherwise it is a plain label, so the level stays visible offline.
 */
export const AgentChatPermissionButton = ({
    chat,
    disabledReason,
    provider,
    theme,
}: {
    chat: AgentChatController;
    /**
     * Why the device cannot change permissions now; see `agentChatDisabledReason` with `action: 'permission'`.
     */
    disabledReason: string | undefined;
    provider: AgentProvider | undefined;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [isOpen, setOpen] = useState(false);
    const selection = useAgentChatPermissionSelection(chat, disabledReason);
    const trigger = agentChatPermissionTrigger(
        selection.snapshot,
        provider,
        disabledReason === undefined,
        t,
    );
    if (!trigger || !provider) return null;
    const Icon = trigger.isFullAccess ? ShieldAlert : ShieldCheck;
    const tone = trigger.isFullAccess ? theme.warning : theme.muted;
    const content = (
        <>
            <Icon color={tone} size={14} />
            <Text
                numberOfLines={1}
                style={[
                    sheetStyles.triggerText,
                    { color: trigger.isFullAccess ? theme.warning : theme.text },
                ]}
            >
                {trigger.label}
            </Text>
            {trigger.isPlanMode ? (
                <Text
                    style={[sheetStyles.triggerCaption, { color: theme.text }]}
                    testID="agent-chat-permission-plan"
                >
                    {t('chat.permission.plan')}
                </Text>
            ) : null}
            {trigger.isInteractive ? <ChevronDown color={theme.muted} size={14} /> : null}
        </>
    );
    const sheet = isOpen ? (
        <AgentChatPermissionSheet
            disabledReason={disabledReason}
            onClose={() => setOpen(false)}
            provider={provider}
            selection={selection}
            theme={theme}
        />
    ) : null;
    if (!trigger.isInteractive)
        return (
            <>
                <View
                    accessibilityLabel={trigger.accessibilityLabel}
                    accessible
                    style={sheetStyles.trigger}
                    testID="agent-chat-permission-label"
                >
                    {content}
                </View>
                {/* An open sheet stays, disabled with the reason, when the connection drops under the reader. */}
                {sheet}
            </>
        );
    return (
        <>
            <Pressable
                accessibilityHint={t('chat.permission.triggerHint')}
                accessibilityLabel={trigger.accessibilityLabel}
                accessibilityRole="button"
                hitSlop={TRIGGER_HIT_SLOP}
                onPress={() => setOpen(true)}
                style={({ pressed }) => [
                    sheetStyles.trigger,
                    pressed ? { backgroundColor: theme.elevated } : null,
                ]}
                testID="agent-chat-permission-button"
            >
                {content}
            </Pressable>
            {sheet}
        </>
    );
};
