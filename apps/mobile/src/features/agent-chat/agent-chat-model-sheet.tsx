/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgentChatModelRequest } from '@caxri/protocol';
import { Check, ChevronDown } from 'lucide-react-native';

import { BottomSheet, SheetCancel } from '../../components/bottom-sheet';
import type { MobileTheme } from '../../theme/tokens';
import {
    agentChatEffortHint,
    agentChatModelOptions,
    agentChatModelSheetNote,
    agentChatModelTrigger,
} from './agent-chat-model-choice';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatModelSelection } from './use-agent-chat-model-selection';

type ModelSelection = ReturnType<typeof useAgentChatModelSelection>;

const OptionRow = ({
    description,
    isBusy,
    isDisabled,
    isSelected,
    label,
    onPress,
    testID,
    theme,
    trailing,
}: {
    description?: string;
    isBusy: boolean;
    isDisabled: boolean;
    isSelected: boolean;
    label: string;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
    trailing?: string;
}) => (
    <Pressable
        accessibilityRole="radio"
        accessibilityState={{ busy: isBusy, checked: isSelected, disabled: isDisabled }}
        disabled={isDisabled}
        onPress={onPress}
        style={({ pressed }) => [
            styles.option,
            { backgroundColor: pressed || isSelected ? theme.elevated : 'transparent' },
        ]}
        testID={testID}
    >
        <View style={styles.optionText}>
            <Text numberOfLines={1} style={[styles.optionLabel, { color: theme.text }]}>
                {label}
            </Text>
            {description ? (
                <Text numberOfLines={2} style={[styles.optionDescription, { color: theme.muted }]}>
                    {description}
                </Text>
            ) : null}
        </View>
        {trailing ? (
            <Text style={[styles.optionTrailing, { color: theme.muted }]}>{trailing}</Text>
        ) : null}
        <View style={styles.optionMark}>
            {isBusy ? (
                <ActivityIndicator color={theme.muted} size="small" />
            ) : isSelected ? (
                <Check color={theme.primary} size={18} strokeWidth={2.5} />
            ) : null}
        </View>
    </Pressable>
);

const SectionLabel = ({ label, theme }: { label: string; theme: MobileTheme }) => (
    <Text accessibilityRole="header" style={[styles.section, { color: theme.muted }]}>
        {label}
    </Text>
);

/**
 * The Desktop composer's model menu as a phone sheet: `Model` and `Reasoning effort` lists that apply on tap. Like the
 * Desktop menu it stays open after a model is chosen, so that model's efforts show right away.
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
    const { busy, error, snapshot } = selection;
    const { efforts, models } = agentChatModelOptions(snapshot);
    const note = agentChatModelSheetNote(snapshot);
    const effortHint = agentChatEffortHint(snapshot);
    const isDisabled = busy !== null || disabledReason !== undefined;
    const select = (change: AgentChatModelRequest, isSelected: boolean): void => {
        // eslint-disable-next-line no-void -- `configure` reports its own failure in the sheet.
        if (!isSelected) void selection.configure(change);
    };
    return (
        <BottomSheet
            closeLabel="Close model and effort"
            maxHeight="80%"
            onClose={onClose}
            testID="agent-chat-model-sheet"
            theme={theme}
        >
            {(dismiss) => (
                <>
                    <ScrollView style={styles.scroll}>
                        <SectionLabel label="Model" theme={theme} />
                        {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- A provider lists a handful of models, and the efforts follow them in the same scroll. */}
                        {models.map((model) => (
                            <OptionRow
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
                            <SectionLabel label="Reasoning effort" theme={theme} />
                        ) : null}
                        {effortHint ? (
                            <Text style={[styles.hint, { color: theme.muted }]}>{effortHint}</Text>
                        ) : null}
                        {efforts.map((effort) => (
                            <OptionRow
                                isBusy={busy?.effort === effort.value}
                                isDisabled={isDisabled}
                                isSelected={effort.isSelected}
                                key={effort.value}
                                label={effort.label}
                                onPress={() => select({ effort: effort.value }, effort.isSelected)}
                                testID={`agent-chat-effort-${effort.value}`}
                                theme={theme}
                                trailing={effort.isDefault ? 'Default' : undefined}
                            />
                        ))}
                    </ScrollView>
                    {note ? (
                        <Text
                            style={[styles.hint, { color: theme.muted }]}
                            testID="agent-chat-model-note"
                        >
                            {note}
                        </Text>
                    ) : null}
                    {disabledReason ? (
                        <Text
                            style={[styles.hint, { color: theme.muted }]}
                            testID="agent-chat-model-disabled-reason"
                        >
                            {disabledReason}
                        </Text>
                    ) : null}
                    {error ? (
                        <Text
                            accessibilityRole="alert"
                            style={[styles.hint, { color: theme.danger }]}
                            testID="agent-chat-model-error"
                        >
                            {error}
                        </Text>
                    ) : null}
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
 * Grows the 40dp model row to a 48dp touch target without making the composer taller.
 */
const TRIGGER_HIT_SLOP = { top: 4, bottom: 4, left: 8, right: 8 } as const;

/**
 * The model and effort the Chat's next turn uses, above the composer input as Desktop keeps them beside its input. It
 * opens the sheet only when the provider listed models and the device may configure the Chat now; otherwise it is a
 * plain label, so the reader still sees which model answers.
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
    const [isOpen, setOpen] = useState(false);
    const selection = useAgentChatModelSelection(chat, disabledReason);
    const trigger = agentChatModelTrigger(selection.snapshot, disabledReason === undefined);
    if (!trigger) return null;
    const content = (
        <>
            <Text numberOfLines={1} style={[styles.triggerModel, { color: theme.text }]}>
                {trigger.model}
            </Text>
            {trigger.effort ? (
                <Text style={[styles.triggerEffort, { color: theme.muted }]}>
                    {`· ${trigger.effort}`}
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
                    style={styles.trigger}
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
                accessibilityHint="Chooses the model and reasoning effort for the next turn."
                accessibilityLabel={trigger.accessibilityLabel}
                accessibilityRole="button"
                hitSlop={TRIGGER_HIT_SLOP}
                onPress={() => setOpen(true)}
                style={({ pressed }) => [
                    styles.trigger,
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

const styles = StyleSheet.create({
    trigger: {
        alignItems: 'center',
        alignSelf: 'flex-start',
        borderRadius: 8,
        flexDirection: 'row',
        gap: 6,
        maxWidth: '100%',
        minHeight: 40,
        paddingHorizontal: 8,
    },
    triggerModel: { flexShrink: 1, fontSize: 13, fontWeight: '600' },
    triggerEffort: { fontSize: 13 },
    scroll: { flexGrow: 0 },
    section: {
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.4,
        paddingHorizontal: 10,
        paddingBottom: 4,
        paddingTop: 12,
        textTransform: 'uppercase',
    },
    option: {
        alignItems: 'center',
        borderRadius: 12,
        flexDirection: 'row',
        gap: 10,
        minHeight: 52,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    optionText: { flex: 1, gap: 2 },
    optionLabel: { fontSize: 16 },
    optionDescription: { fontSize: 13, lineHeight: 18 },
    optionTrailing: { fontSize: 13 },
    optionMark: { alignItems: 'center', width: 24 },
    hint: { fontSize: 13, lineHeight: 18, paddingHorizontal: 10, paddingVertical: 6 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
