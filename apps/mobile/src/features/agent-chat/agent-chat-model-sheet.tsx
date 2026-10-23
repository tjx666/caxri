import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { AgentChatModelRequest } from '@caxri/protocol';
import { ChevronDown } from 'lucide-react-native';

import { BottomSheet, SheetCancel } from '../../components/bottom-sheet';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import {
    agentChatEffortHint,
    agentChatModelOptions,
    agentChatModelSheetNote,
    agentChatModelTrigger,
    agentChatUltracodeToggle,
} from './agent-chat-model-choice';
import { AgentChatPlanLimitsSection } from './agent-chat-plan-limits-section';
import {
    SheetMessages,
    SheetOptionRow,
    SheetSectionLabel,
    SheetToggleRow,
} from './agent-chat-sheet-primitives';
import { sheetStyles, TRIGGER_HIT_SLOP } from './agent-chat-sheet-styles';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatModelSelection } from './use-agent-chat-choice';

type ModelSelection = ReturnType<typeof useAgentChatModelSelection>;

/**
 * The Desktop composer's model menu as a phone sheet: `Model` and `Reasoning effort` lists that apply on tap, Claude
 * Code's Ultracode switch below them while the provider offers it for the model, and the plan's rate limits last, which
 * Desktop shows in its status bar. Like the Desktop menu it stays open after a model is chosen, so that model's efforts
 * show right away.
 */
const AgentChatModelSheet = ({
    disabledReason,
    onClose,
    selection,
    theme,
}: {
    /**
     * Why the device cannot configure the Chat right now, such as a dropped connection. The open sheet keeps its lists
     * but disables them and says why, instead of vanishing under the reader's finger.
     */
    disabledReason: string | undefined;
    onClose: () => void;
    /**
     * Owned by the trigger, so a pending choice outlives the sheet and the trigger shows it too.
     */
    selection: ModelSelection;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { busy, error, snapshot } = selection;
    const { efforts, models } = agentChatModelOptions(snapshot, t);
    const ultracode = agentChatUltracodeToggle(snapshot, t);
    const effortHint = agentChatEffortHint(snapshot, t);
    const isDisabled = busy !== null || disabledReason !== undefined;
    const select = (change: AgentChatModelRequest, isSelected: boolean): void => {
        if (!isSelected) void selection.didConfigure(change);
    };
    return (
        <BottomSheet
            closeLabel={t('chat.model.close')}
            maxHeight="80%"
            onClose={onClose}
            testID="agent-chat-model-sheet"
            theme={theme}
        >
            {(dismiss) => (
                <>
                    <ScrollView style={sheetStyles.scroll}>
                        <SheetSectionLabel label={t('chat.model.model')} theme={theme} />
                        {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- A provider lists a handful of models, and the efforts follow them in the same scroll. */}
                        {models.map((model) => (
                            <SheetOptionRow
                                description={model.description}
                                isBusy={busy?.model === model.id}
                                isDisabled={isDisabled}
                                isSelected={model.isSelected}
                                key={model.id}
                                label={model.displayName}
                                onPress={() => select({ model: model.id }, model.isSelected)}
                                testID={`agent-chat-model-${model.id}`}
                                theme={theme}
                            />
                        ))}
                        {effortHint || efforts.length > 0 ? (
                            <SheetSectionLabel
                                label={t('chat.model.reasoningEffort')}
                                theme={theme}
                            />
                        ) : null}
                        {effortHint ? (
                            <Text style={[sheetStyles.hint, { color: theme.muted }]}>
                                {effortHint}
                            </Text>
                        ) : null}
                        {efforts.map((effort) => (
                            <SheetOptionRow
                                isBusy={busy?.effort === effort.value}
                                isDisabled={isDisabled}
                                isSelected={effort.isSelected}
                                key={effort.value}
                                label={effort.label}
                                onPress={() => select({ effort: effort.value }, effort.isSelected)}
                                testID={`agent-chat-effort-${effort.value}`}
                                theme={theme}
                                trailing={effort.isDefault ? t('chat.model.default') : undefined}
                            />
                        ))}
                        {ultracode ? (
                            <SheetToggleRow
                                description={ultracode.description}
                                isBusy={busy?.ultracode !== undefined}
                                isDisabled={isDisabled}
                                isOn={ultracode.isOn}
                                label={ultracode.label}
                                onToggle={(isOn) => select({ ultracode: isOn }, false)}
                                testID="agent-chat-ultracode"
                                theme={theme}
                            />
                        ) : null}
                        {selection.snapshot?.terminalId ? (
                            <AgentChatPlanLimitsSection
                                terminalId={selection.snapshot.terminalId}
                                theme={theme}
                            />
                        ) : null}
                    </ScrollView>
                    <SheetMessages
                        disabledReason={disabledReason}
                        error={error}
                        note={agentChatModelSheetNote(snapshot, t)}
                        testIDPrefix="agent-chat-model"
                        theme={theme}
                    />
                    <SheetCancel
                        label="Done"
                        onPress={dismiss}
                        testID="agent-chat-model-done"
                        theme={theme}
                    />
                </>
            )}
        </BottomSheet>
    );
};

/**
 * The model and effort the Chat's next turn uses, above the composer input as Desktop keeps them beside its input,
 * followed by `Ultracode` while it is on. It opens the sheet only when the provider listed models and the device may
 * configure the Chat now; otherwise it is a plain label, so the reader still sees which model answers.
 */
export const AgentChatModelButton = ({
    chat,
    disabledReason,
    theme,
}: {
    chat: AgentChatController;
    /**
     * Why the device cannot configure the Chat now; see `agentChatDisabledReason`.
     */
    disabledReason: string | undefined;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [isOpen, setOpen] = useState(false);
    const selection = useAgentChatModelSelection(chat, disabledReason);
    const trigger = agentChatModelTrigger(selection.snapshot, disabledReason === undefined, t);
    if (!trigger) return null;
    const content = (
        <>
            <Text numberOfLines={1} style={[sheetStyles.triggerText, { color: theme.text }]}>
                {trigger.model}
            </Text>
            {trigger.effort ? (
                <Text style={[sheetStyles.triggerCaption, { color: theme.muted }]}>
                    {`· ${trigger.effort}`}
                </Text>
            ) : null}
            {/* A mode word, set like the Desktop trigger's `Ultracode`. */}
            {trigger.isUltracode ? (
                <Text
                    style={[sheetStyles.triggerCaption, { color: theme.text }]}
                    testID="agent-chat-model-ultracode"
                >
                    Ultracode
                </Text>
            ) : null}
            {trigger.isInteractive ? <ChevronDown color={theme.muted} size={14} /> : null}
        </>
    );
    const sheet = isOpen ? (
        <AgentChatModelSheet
            disabledReason={disabledReason}
            onClose={() => setOpen(false)}
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
                    testID="agent-chat-model-label"
                >
                    {content}
                </View>
                {sheet}
            </>
        );
    return (
        <>
            <Pressable
                accessibilityHint={t('chat.model.triggerHint')}
                accessibilityLabel={trigger.accessibilityLabel}
                accessibilityRole="button"
                hitSlop={TRIGGER_HIT_SLOP}
                onPress={() => setOpen(true)}
                style={({ pressed }) => [
                    sheetStyles.trigger,
                    pressed ? { backgroundColor: theme.elevated } : null,
                ]}
                testID="agent-chat-model-button"
            >
                {content}
            </Pressable>
            {sheet}
        </>
    );
};
