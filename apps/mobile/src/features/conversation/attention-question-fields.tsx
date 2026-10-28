/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { MethodResult } from '@caxri/protocol';
import { Check } from 'lucide-react-native';

import { Button } from '../../components/button';
import { useTranslation } from '../../i18n';
import {
    mobileControl,
    mobileRadius,
    mobileSpace,
    mobileType,
    PRESSED_OPACITY,
} from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import type { AttentionAnswerDraft } from './attention-answer';
import { isAttentionAnswerDraftEmpty } from './attention-answer';

type Attention = MethodResult<'mobile.attention.list'>['requests'][number];

/**
 * One question of a Terminal Agent's request, drawn like the Agent Chat's question form: option rows at the 48dp
 * minimum (the chosen one outlined and checked, so selection never rests on color alone), a free-text answer, and one
 * primary button that advances or submits.
 */
export const AttentionQuestionFields = ({
    advance,
    canAnswer,
    draft,
    onFreeTextChange,
    onToggleOption,
    question,
    questionCount,
    questionIndex,
    theme,
}: {
    advance: () => Promise<void>;
    canAnswer: boolean;
    draft: AttentionAnswerDraft;
    onFreeTextChange: (value: string) => void;
    onToggleOption: (label: string) => void;
    question: Attention['questions'][number];
    questionCount: number;
    questionIndex: number;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const selectedOptions = new Set(draft.selectedOptions);
    const isLastQuestion = questionIndex + 1 >= questionCount;
    return (
        <View style={styles.root}>
            <Text style={[styles.question, { color: theme.text }]}>{question.question}</Text>
            {question.options.map((option, optionIndex) => {
                const isSelected = selectedOptions.has(option.label);
                return (
                    <Pressable
                        accessibilityLabel={option.label}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !canAnswer, selected: isSelected }}
                        disabled={!canAnswer}
                        key={option.label}
                        onPress={() => onToggleOption(option.label)}
                        style={({ pressed }) => [
                            styles.option,
                            {
                                backgroundColor: isSelected ? theme.selection : 'transparent',
                                borderColor: isSelected ? theme.primary : theme.border,
                                opacity: pressed ? PRESSED_OPACITY : 1,
                            },
                        ]}
                        testID={`attention-option-${questionIndex}-${optionIndex}`}
                    >
                        <View style={styles.optionText}>
                            <Text style={[styles.optionLabel, { color: theme.text }]}>
                                {option.label}
                            </Text>
                            {option.description ? (
                                <Text style={[styles.optionDescription, { color: theme.muted }]}>
                                    {option.description}
                                </Text>
                            ) : null}
                        </View>
                        {isSelected ? <Check color={theme.primary} size={18} /> : null}
                    </Pressable>
                );
            })}
            {canAnswer ? (
                <>
                    <TextInput
                        accessibilityLabel={t('conversation.attention.answerLabel')}
                        onChangeText={onFreeTextChange}
                        placeholder={t('conversation.attention.answerPlaceholder')}
                        placeholderTextColor={theme.muted}
                        style={[styles.input, { borderColor: theme.border, color: theme.text }]}
                        testID="attention-answer-input"
                        value={draft.freeText}
                    />
                    <Button
                        isDisabled={isAttentionAnswerDraftEmpty(draft)}
                        label={t(
                            isLastQuestion
                                ? 'conversation.attention.submitAnswers'
                                : 'conversation.attention.nextQuestion',
                        )}
                        onPress={() => {
                            void advance();
                        }}
                        testID="attention-answer-next"
                        theme={theme}
                        variant="primary"
                    />
                </>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    root: { gap: mobileSpace.sm },
    question: mobileType.body,
    option: {
        alignItems: 'center',
        borderRadius: mobileRadius.md,
        borderWidth: 1,
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.sm,
    },
    optionText: { flex: 1, gap: mobileSpace.xxs, minWidth: 0 },
    optionLabel: mobileType.bodyStrong,
    optionDescription: mobileType.meta,
    input: {
        ...mobileType.body,
        borderRadius: mobileRadius.md,
        borderWidth: 1,
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.md,
    },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
