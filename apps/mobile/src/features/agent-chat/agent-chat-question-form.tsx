/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
    agentChatQuestionAnswers,
    agentChatQuestionDefaults,
    agentChatQuestionMultiDefaults,
    agentChatQuestionOption,
    toggleAgentChatQuestionOption,
} from '@caxri/protocol';
import { Circle, CircleDot, Square, SquareCheck } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import type { QuestionRequest } from './agent-chat-question-prompt';
import { QuestionPrompt } from './agent-chat-question-prompt';
import { agentChatQuestionAdvance, agentChatQuestionFooter } from './agent-chat-request-flow';
import type { RequestActions } from './agent-chat-request-parts';
import { ActionButton } from './agent-chat-request-parts';

const withoutKey = <T,>(record: Readonly<Record<string, T>>, key: string): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== key));

/**
 * Whether the software keyboard is up. The dock shares the screen with the keyboard and the composer, so the question
 * card drops its header and clamps the question while the keyboard is up, keeping its answer row and buttons on
 * screen.
 */
const useIsKeyboardVisible = (): boolean => {
    const [isVisible, setVisible] = useState(() => Keyboard.isVisible());
    useEffect(() => {
        const show = Keyboard.addListener('keyboardDidShow', () => setVisible(true));
        const hide = Keyboard.addListener('keyboardDidHide', () => setVisible(false));
        return () => {
            show.remove();
            hide.remove();
        };
    }, []);
    return isVisible;
};

/**
 * One compact answer row: a radio glyph (a checkbox for a `multiSelect` question), the option, and at most two lines of
 * its description. Claude Code's `(Recommended)` label suffix becomes a badge, as on Desktop; the answer still sends
 * the provider its original label.
 */
const QuestionOptionRow = ({
    isMulti,
    isSelected,
    onPress,
    option,
    testID,
    theme,
}: {
    isMulti: boolean;
    isSelected: boolean;
    onPress: () => void;
    option: QuestionRequest['questions'][number]['options'][number];
    testID: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { isRecommended, text } = agentChatQuestionOption(option.label);
    const Glyph = isMulti ? (isSelected ? SquareCheck : Square) : isSelected ? CircleDot : Circle;
    return (
        <Pressable
            accessibilityHint={option.description || undefined}
            accessibilityLabel={
                isRecommended ? t('chat.question.recommendedLabel', { text }) : text
            }
            accessibilityRole={isMulti ? 'checkbox' : 'radio'}
            accessibilityState={{ checked: isSelected }}
            onPress={onPress}
            style={({ pressed }) => [
                styles.option,
                {
                    backgroundColor: isSelected || pressed ? theme.elevated : 'transparent',
                    borderColor: isSelected ? theme.primary : theme.border,
                },
            ]}
            testID={testID}
        >
            <Glyph
                aria-hidden
                color={isSelected ? theme.primary : theme.muted}
                size={18}
                style={styles.glyph}
            />
            <View style={styles.optionText}>
                <View style={styles.optionLabelRow}>
                    <Text numberOfLines={2} style={[styles.optionLabel, { color: theme.text }]}>
                        {text}
                    </Text>
                    {isRecommended ? (
                        <Text
                            style={[styles.badge, { borderColor: theme.border, color: theme.text }]}
                        >
                            {t('chat.question.recommended')}
                        </Text>
                    ) : null}
                </View>
                {option.description ? (
                    <Text
                        numberOfLines={2}
                        style={[styles.optionDescription, { color: theme.muted }]}
                    >
                        {option.description}
                    </Text>
                ) : null}
            </View>
        </Pressable>
    );
};

/**
 * The typed answer. Under options it starts as a one-line `Other…` row so it does not cost a text field's height until
 * it is wanted; a tap opens the field with the keyboard. A question without options shows the field at once. The
 * keyboard's return key answers, the way a tap on an option does.
 */
const QuestionOtherRow = ({
    hasOptions,
    isMulti,
    isOpen,
    onChange,
    onFocusChange,
    onOpen,
    onSubmit,
    question,
    questionIndex,
    returnKeyType,
    theme,
    value,
}: {
    hasOptions: boolean;
    /**
     * A `multiSelect` question's typed answer joins its ticks, so it wears a checkbox like they do.
     */
    isMulti: boolean;
    isOpen: boolean;
    onChange: (value: string) => void;
    onFocusChange: (isFocused: boolean) => void;
    onOpen: () => void;
    onSubmit: () => void;
    question: string;
    questionIndex: number;
    returnKeyType: 'next' | 'send';
    theme: MobileTheme;
    value: string;
}) => {
    const { t } = useTranslation();
    const isAnswered = value.trim().length > 0;
    const Glyph = isMulti ? (isAnswered ? SquareCheck : Square) : isAnswered ? CircleDot : Circle;
    const glyph = hasOptions ? (
        <Glyph
            aria-hidden
            color={isAnswered ? theme.primary : theme.muted}
            size={18}
            style={styles.glyph}
        />
    ) : null;
    if (!isOpen)
        return (
            <Pressable
                accessibilityHint={t('chat.question.otherHint')}
                accessibilityLabel={t('chat.question.otherAnswer')}
                accessibilityRole="button"
                onPress={onOpen}
                style={({ pressed }) => [
                    styles.option,
                    styles.otherClosed,
                    {
                        backgroundColor: pressed ? theme.elevated : 'transparent',
                        borderColor: theme.border,
                    },
                ]}
                testID={`agent-chat-question-${questionIndex}-other-open`}
            >
                {glyph}
                <Text style={[styles.optionLabel, { color: theme.muted }]}>
                    {t('chat.question.other')}
                </Text>
            </Pressable>
        );
    return (
        <View
            style={[
                styles.otherOpen,
                {
                    backgroundColor: theme.surface,
                    borderColor: isAnswered ? theme.primary : theme.border,
                },
            ]}
        >
            {glyph}
            <TextInput
                accessibilityLabel={t('chat.question.answerLabel', { question })}
                autoFocus={hasOptions}
                submitBehavior="submit"
                onBlur={() => onFocusChange(false)}
                onChangeText={onChange}
                onFocus={() => onFocusChange(true)}
                onSubmitEditing={onSubmit}
                placeholder={t(
                    hasOptions ? 'chat.question.otherAnswer' : 'chat.question.yourAnswer',
                )}
                placeholderTextColor={theme.muted}
                returnKeyType={returnKeyType}
                style={[styles.input, { color: theme.text }]}
                testID={`agent-chat-question-${questionIndex}-other`}
                value={value}
            />
        </View>
    );
};

/**
 * Skip, plus the footer `agentChatQuestionFooter` derives: nothing more for one tap-to-send question, Submit for a
 * typed answer, and Back / Next / Submit across several questions.
 */
const QuestionActions = ({
    actions,
    answers,
    footer,
    onBack,
    onNext,
    theme,
}: {
    actions: RequestActions;
    answers: Record<string, string[]>;
    footer: ReturnType<typeof agentChatQuestionFooter>;
    onBack: () => void;
    onNext: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View style={styles.actions}>
            <ActionButton
                disabled={actions.isDisabled}
                isPending={actions.pendingAction === 'agent-chat-question-skip'}
                label={t('chat.question.skip')}
                onPress={() => {
                    void actions.respond('agent-chat-question-skip', {
                        kind: 'decision',
                        decision: 'cancel',
                    });
                }}
                testID="agent-chat-question-skip"
                theme={theme}
                tone="plain"
            />
            {footer.isBackShown ? (
                <ActionButton
                    disabled={actions.pendingAction !== null}
                    isPending={false}
                    label={t('chat.question.back')}
                    onPress={onBack}
                    testID="agent-chat-question-back"
                    theme={theme}
                    tone="plain"
                />
            ) : null}
            {footer.primary === 'next' ? (
                <ActionButton
                    disabled={actions.pendingAction !== null}
                    isPending={false}
                    label={t('chat.question.next')}
                    onPress={onNext}
                    testID="agent-chat-question-next"
                    theme={theme}
                    tone="primary"
                />
            ) : null}
            {footer.primary === 'submit' ? (
                <ActionButton
                    disabled={actions.isDisabled || !footer.canSubmit}
                    isPending={actions.pendingAction === 'agent-chat-question-submit'}
                    label={t('chat.question.submit')}
                    onPress={() => {
                        void actions.respond('agent-chat-question-submit', {
                            kind: 'answers',
                            answers,
                        });
                    }}
                    testID="agent-chat-question-submit"
                    theme={theme}
                    tone="primary"
                />
            ) : null}
        </View>
    );
};

/**
 * The options in their own scroll area, which shrinks first when space runs out. A one-option question's option shows
 * as selected only while no typed answer replaces it; a `multiSelect` question's ticks stay beside a typed answer,
 * which joins them.
 */
const QuestionOptions = ({
    isSelected,
    onChoose,
    question,
    questionIndex,
    theme,
}: {
    isSelected: (label: string) => boolean;
    onChoose: (label: string) => void;
    question: QuestionRequest['questions'][number];
    questionIndex: number;
    theme: MobileTheme;
}) => (
    <ScrollView
        contentContainerStyle={styles.optionList}
        keyboardShouldPersistTaps="handled"
        persistentScrollbar
        style={styles.scroll}
        testID={`agent-chat-question-${questionIndex}-options`}
    >
        {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- `agentChatRequestSchema` caps a question at 20 options. */}
        {question.options.map((option, optionIndex) => (
            <QuestionOptionRow
                key={option.label}
                isMulti={question.multiSelect === true}
                isSelected={isSelected(option.label)}
                onPress={() => onChoose(option.label)}
                option={option}
                testID={`agent-chat-question-${questionIndex}-option-${optionIndex}`}
                theme={theme}
            />
        ))}
    </ScrollView>
);

/**
 * One question at a time in three parts, so a phone never scrolls the question away from its answers: a fixed top
 * (tabs, header, the question clamped to three lines with Show more), the options in their own scroll area that shrinks
 * first when space runs out, and a fixed bottom (the typed answer, `notice` explaining why answering is blocked, and
 * the buttons). While the keyboard is up the header goes and the question clamps to two lines; while the typed answer
 * has the keyboard, the options step aside too.
 */
export const AgentChatQuestionForm = ({
    actions,
    notice,
    request,
    theme,
}: {
    actions: RequestActions;
    notice: ReactNode;
    request: QuestionRequest;
    theme: MobileTheme;
}) => {
    const isKeyboardVisible = useIsKeyboardVisible();
    const [selected, setSelected] = useState(() => agentChatQuestionDefaults(request));
    /**
     * The ticked options of each `multiSelect` question, starting on its recommended option as Desktop does.
     */
    const [picked, setPicked] = useState(() => agentChatQuestionMultiDefaults(request));
    const [typed, setTyped] = useState<Record<string, string>>({});
    const [openOther, setOpenOther] = useState<Record<string, true>>({});
    /**
     * The question whose typed answer has focus. Kept per question so a field that unmounts without a blur (moving to
     * another question) does not leave the next question's options hidden.
     */
    const [typingQuestionId, setTypingQuestionId] = useState<string | undefined>();
    const [questionIndex, setQuestionIndex] = useState(0);
    /**
     * Questions the user has opened. A recommended default on an unopened question is not an answer the user gave, so
     * answering and Submit open it first.
     */
    const [seen, setSeen] = useState<ReadonlySet<number>>(() => new Set([0]));
    const openQuestion = (nextIndex: number): void => {
        setQuestionIndex(nextIndex);
        setSeen((current) => (current.has(nextIndex) ? current : new Set([...current, nextIndex])));
    };
    const { answers } = agentChatQuestionAnswers(request, { ...selected, ...picked }, typed);
    const footer = agentChatQuestionFooter({
        answers,
        index: questionIndex,
        request,
        seen,
        typed,
    });
    const question = request.questions.at(questionIndex);
    if (!question) return notice;
    const hasOptions = question.options.length > 0;
    const typedAnswer = typed[question.id] ?? '';
    /**
     * A tap or the keyboard's send key answers, as in the Codex app: it moves on to the next unanswered question, and
     * answering the last one sends the card, so a single question needs one tap. A device that cannot answer only moves
     * the selection.
     */
    const advance = (nextSelected: Record<string, string>, nextTyped: Record<string, string>) => {
        setSelected(nextSelected);
        setTyped(nextTyped);
        const nextAnswers = agentChatQuestionAnswers(
            request,
            { ...nextSelected, ...picked },
            nextTyped,
        ).answers;
        const step = agentChatQuestionAdvance(request, nextAnswers, questionIndex, seen);
        if (step.kind === 'move') openQuestion(step.index);
        else if (actions.isShowsActions && !actions.isDisabled)
            void actions.respond('agent-chat-question-submit', {
                kind: 'answers',
                answers: nextAnswers,
            });
    };
    const isMulti = question.multiSelect === true;
    /**
     * A `multiSelect` tap ticks or unticks the option and stays on the question; Next or Submit moves on, as on
     * Desktop.
     */
    const toggleOption = (label: string): void => {
        setPicked((current) => ({
            ...current,
            [question.id]: toggleAgentChatQuestionOption(current[question.id] ?? [], label),
        }));
    };
    const answerWithOption = (label: string): void => {
        // Picking an option replaces a typed answer for this question, as on Desktop.
        setOpenOther((current) => withoutKey(current, question.id));
        advance({ ...selected, [question.id]: label }, withoutKey(typed, question.id));
    };
    const answerWithTyped = (): void => {
        if (!typedAnswer.trim()) return;
        // The field stays focused on submit (`submitBehavior="submit"`); drop the keyboard so the next question or the
        // sent card shows in full.
        Keyboard.dismiss();
        advance(selected, typed);
    };
    const isTyping = typingQuestionId === question.id;
    const isOptionsShown = !(isKeyboardVisible && isTyping) && hasOptions;
    return (
        <>
            <QuestionPrompt
                answers={answers}
                index={questionIndex}
                isKeyboardVisible={isKeyboardVisible}
                question={question}
                request={request}
                seen={seen}
                setIndex={openQuestion}
                theme={theme}
            />
            {isOptionsShown ? (
                <QuestionOptions
                    isSelected={(label) =>
                        isMulti
                            ? (picked[question.id] ?? []).includes(label)
                            : !typedAnswer.trim() && selected[question.id] === label
                    }
                    onChoose={isMulti ? toggleOption : answerWithOption}
                    question={question}
                    questionIndex={questionIndex}
                    theme={theme}
                />
            ) : null}
            <View style={styles.questionBottom}>
                {!hasOptions || question.allowsOther ? (
                    <QuestionOtherRow
                        key={question.id}
                        hasOptions={hasOptions}
                        isMulti={isMulti}
                        isOpen={!hasOptions || openOther[question.id] || !!typedAnswer}
                        onChange={(value) =>
                            setTyped((current) => ({ ...current, [question.id]: value }))
                        }
                        onFocusChange={(isFocused) =>
                            setTypingQuestionId(isFocused ? question.id : undefined)
                        }
                        onOpen={() =>
                            setOpenOther((current) => ({ ...current, [question.id]: true }))
                        }
                        onSubmit={answerWithTyped}
                        question={question.question}
                        questionIndex={questionIndex}
                        returnKeyType={
                            agentChatQuestionAdvance(request, answers, questionIndex, seen).kind ===
                            'send'
                                ? 'send'
                                : 'next'
                        }
                        theme={theme}
                        value={typedAnswer}
                    />
                ) : null}
                {notice}
                {actions.isShowsActions ? (
                    <QuestionActions
                        actions={actions}
                        answers={answers}
                        footer={footer}
                        onBack={() => openQuestion(questionIndex - 1)}
                        onNext={() => openQuestion(questionIndex + 1)}
                        theme={theme}
                    />
                ) : null}
            </View>
        </>
    );
};

const styles = StyleSheet.create({
    questionBottom: { gap: 8 },
    scroll: { flexGrow: 0, flexShrink: 1 },
    optionList: { gap: 6 },
    /**
     * Compact rows (44dp, like the key bar) so a phone shows more of a question's options before scrolling.
     */
    option: {
        alignItems: 'flex-start',
        borderRadius: 10,
        borderWidth: 1,
        flexDirection: 'row',
        gap: 10,
        minHeight: 44,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    glyph: { marginTop: 1 },
    optionText: { flex: 1, gap: 2 },
    optionLabelRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    optionLabel: { flexShrink: 1, fontSize: 15, fontWeight: '600', lineHeight: 20 },
    optionDescription: { fontSize: 13, lineHeight: 18 },
    badge: {
        borderRadius: 6,
        borderWidth: 1,
        fontSize: 11,
        fontWeight: '700',
        lineHeight: 16,
        overflow: 'hidden',
        paddingHorizontal: 6,
    },
    otherClosed: { alignItems: 'center' },
    otherOpen: {
        alignItems: 'center',
        borderRadius: 10,
        borderWidth: 1,
        flexDirection: 'row',
        gap: 10,
        minHeight: 44,
        paddingLeft: 10,
    },
    input: { flex: 1, fontSize: 15, minHeight: 44, paddingRight: 12 },
    actions: { flexDirection: 'row', gap: 8 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
