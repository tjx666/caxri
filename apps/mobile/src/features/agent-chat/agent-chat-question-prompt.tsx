/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentChatRequest } from '@caxri/protocol';
import { Check } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { ClampedText } from './agent-chat-request-parts';

export type QuestionRequest = Extract<AgentChatRequest, { kind: 'question' }>;

/**
 * Several questions sit behind `Q1 Q2 Q3` tabs so the card stays one question tall on a phone; a tab carries a check
 * once its question has an answer the user has seen (a recommended default on an unopened question earns none). Test
 * IDs use positions, not provider question IDs or option labels: Android resource IDs only admit lowercase identifiers,
 * and a label is free text.
 */
const QuestionTabs = ({
    answers,
    index,
    request,
    seen,
    setIndex,
    theme,
}: {
    answers: Readonly<Record<string, string[]>>;
    index: number;
    request: QuestionRequest;
    seen: ReadonlySet<number>;
    setIndex: (index: number) => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View accessibilityRole="tablist" style={styles.tabs}>
            {request.questions.map((question, questionIndex) => {
                const isSelected = questionIndex === index;
                const isAnswered = seen.has(questionIndex) && Object.hasOwn(answers, question.id);
                const color = isSelected ? theme.text : theme.muted;
                return (
                    <Pressable
                        key={question.id}
                        accessibilityLabel={t(
                            isAnswered
                                ? 'chat.question.tabAnswered'
                                : 'chat.question.tabUnanswered',
                            {
                                count: request.questions.length,
                                index: questionIndex + 1,
                                question: question.header || question.question,
                            },
                        )}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: isSelected }}
                        onPress={() => setIndex(questionIndex)}
                        style={[
                            styles.tab,
                            { borderBottomColor: isSelected ? theme.primary : 'transparent' },
                        ]}
                        testID={`agent-chat-question-tab-${questionIndex}`}
                    >
                        <Text style={[styles.tabLabel, { color }]}>
                            {t('chat.question.tab', { index: questionIndex + 1 })}
                        </Text>
                        {isAnswered ? <Check color={theme.success} size={14} /> : null}
                    </Pressable>
                );
            })}
            <Text style={[styles.step, { color: theme.muted }]} testID="agent-chat-question-step">
                {t('chat.request.position', { count: request.questions.length, index: index + 1 })}
            </Text>
        </View>
    );
};

/**
 * The fixed top of the card: the tabs across several questions, the header, and the question itself. While the keyboard
 * is up the header goes and the question clamps to two lines without Show more.
 */
export const QuestionPrompt = ({
    answers,
    index,
    isKeyboardVisible,
    question,
    request,
    seen,
    setIndex,
    theme,
}: {
    answers: Readonly<Record<string, string[]>>;
    index: number;
    isKeyboardVisible: boolean;
    question: QuestionRequest['questions'][number];
    request: QuestionRequest;
    seen: ReadonlySet<number>;
    setIndex: (index: number) => void;
    theme: MobileTheme;
}) => (
    <View style={styles.questionTop}>
        {request.questions.length > 1 ? (
            <QuestionTabs
                answers={answers}
                index={index}
                request={request}
                seen={seen}
                setIndex={setIndex}
                theme={theme}
            />
        ) : null}
        {!isKeyboardVisible && question.header ? (
            <Text numberOfLines={1} style={[styles.header, { color: theme.muted }]}>
                {question.header}
            </Text>
        ) : null}
        {isKeyboardVisible ? (
            <Text numberOfLines={2} style={[styles.questionText, { color: theme.text }]}>
                {question.question}
            </Text>
        ) : (
            <ClampedText
                key={question.id}
                maxLines={3}
                style={[styles.questionText, { color: theme.text }]}
                testID={`agent-chat-question-${index}-text`}
                text={question.question}
                theme={theme}
            />
        )}
    </View>
);

const styles = StyleSheet.create({
    header: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
    questionTop: { gap: 4 },
    questionText: { fontSize: 15, fontWeight: '600', lineHeight: 21 },
    tabs: { alignItems: 'center', flexDirection: 'row', gap: 4 },
    step: { fontSize: 12, fontVariant: ['tabular-nums'], marginLeft: 'auto' },
    tab: {
        alignItems: 'center',
        borderBottomWidth: 2,
        flexDirection: 'row',
        gap: 4,
        justifyContent: 'center',
        minHeight: 44,
        minWidth: 48,
        paddingHorizontal: 8,
    },
    tabLabel: { fontSize: 14, fontWeight: '700' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
