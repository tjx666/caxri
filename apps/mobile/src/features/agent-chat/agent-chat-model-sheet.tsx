/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

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

interface Pending {
    kind: 'model' | 'effort';
    value: string;
}

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
    chat,
    disabledReason,
    onClose,
    theme,
}: {
    chat: AgentChatController;
    /**
     * Why the device cannot configure the Chat right now, such as a dropped connection. The open sheet keeps its lists
     * but disables them and says why, instead of vanishing under the reader's finger.
     */
    disabledReason: string | undefined;
    onClose: () => void;
    theme: MobileTheme;
}) => {
    const [pending, setPending] = useState<Pending | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { efforts, models } = agentChatModelOptions(chat.snapshot);
    const note = agentChatModelSheetNote(chat.snapshot);
    const effortHint = agentChatEffortHint(chat.snapshot);
    const choose = async (next: Pending): Promise<void> => {
        setPending(next);
        setError(null);
        try {
            await chat.configure(
                next.kind === 'model' ? { model: next.value } : { effort: next.value },
            );
        } catch {
            setError(
                next.kind === 'model'
                    ? 'The model could not be changed. Try again.'
                    : 'The reasoning effort could not be changed. Try again.',
            );
        } finally {
            setPending(null);
        }
    };
    const select = (next: Pending, isSelected: boolean): void => {
        // eslint-disable-next-line no-void -- `choose` reports its own failure in the sheet.
        if (!isSelected) void choose(next);
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
                        {models.map((model) => (
                            <OptionRow
                                description={model.description}
                                isBusy={pending?.kind === 'model' && pending.value === model.id}
                                isDisabled={pending !== null || disabledReason !== undefined}
                                isSelected={model.isSelected}
                                key={model.id}
                                label={model.displayName}
                                onPress={() =>
                                    select({ kind: 'model', value: model.id }, model.isSelected)
                                }
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
                                isBusy={
                                    pending?.kind === 'effort' && pending.value === effort.value
                                }
                                isDisabled={pending !== null || disabledReason !== undefined}
                                isSelected={effort.isSelected}
                                key={effort.value}
                                label={effort.label}
                                onPress={() =>
                                    select(
                                        { kind: 'effort', value: effort.value },
                                        effort.isSelected,
                                    )
                                }
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
    const trigger = agentChatModelTrigger(chat.snapshot, disabledReason === undefined);
    if (!trigger) return null;
    const content = (
        <>
            <Text numberOfLines={1} style={[styles.triggerModel, { color: theme.text }]}>
                {trigger.model}
            </Text>
            {trigger.effort ? (
                <Text style={[styles.triggerEffort, { color: theme.muted }]}>{trigger.effort}</Text>
            ) : null}
            {trigger.isInteractive ? <ChevronDown color={theme.muted} size={14} /> : null}
        </>
    );
    const sheet = isOpen ? (
        <AgentChatModelSheet
            chat={chat}
            disabledReason={disabledReason}
            onClose={() => setOpen(false)}
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
                hitSlop={8}
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
        minHeight: 32,
        paddingHorizontal: 6,
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
