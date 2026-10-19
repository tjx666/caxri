/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ChevronRight, CircleQuestionMark } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles } from '../conversation/conversation-styles';
import type { AgentChatTimelineEntry } from './agent-chat-timeline';

type AnsweredEntry = Extract<AgentChatTimelineEntry, { kind: 'answered' }>;

/**
 * An answered question request in the transcript, as Desktop records it: `Asked 3 questions` over each question and the
 * answer given (a multi-choice answer is comma separated; a skipped question reads `Skipped`). It starts expanded,
 * since the answers are what the next reply acts on, and the list owns the folded state by entry id so a recycled row
 * never carries another request's.
 */
export const AgentChatAnsweredQuestions = ({
    entry,
    onToggle,
    theme,
}: {
    entry: AnsweredEntry;
    onToggle: (id: string) => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { answers, isExpanded } = entry;
    const label =
        answers.length === 1
            ? t('chat.answered.askedOne')
            : t('chat.answered.askedOther', { count: answers.length });
    return (
        <View style={conversationStyles.message} testID="agent-chat-answered">
            <Pressable
                accessibilityHint={t(
                    isExpanded ? 'chat.answered.hideAnswers' : 'chat.answered.showAnswers',
                )}
                accessibilityLabel={label}
                accessibilityRole="button"
                accessibilityState={{ expanded: isExpanded }}
                onPress={() => onToggle(entry.id)}
                style={({ pressed }) => [styles.header, pressed ? styles.pressed : null]}
                testID="agent-chat-answered-toggle"
            >
                <CircleQuestionMark color={theme.muted} size={14} />
                <Text numberOfLines={1} style={[styles.label, { color: theme.muted }]}>
                    {label}
                </Text>
                <ChevronRight
                    color={theme.muted}
                    size={14}
                    style={isExpanded ? styles.chevronOpen : null}
                />
            </Pressable>
            {isExpanded ? (
                <View style={styles.list}>
                    {answers.map(({ answer, question }, index) => (
                        <View key={question} style={styles.item}>
                            <Text
                                selectable
                                style={[styles.text, { color: theme.muted }]}
                                testID={`agent-chat-answered-question-${index}`}
                            >
                                {question}
                            </Text>
                            <Text
                                selectable
                                style={[
                                    styles.text,
                                    styles.answer,
                                    answer ? null : styles.skipped,
                                    { color: theme.muted },
                                ]}
                                testID={`agent-chat-answered-answer-${index}`}
                            >
                                {answer || t('chat.answered.skipped')}
                            </Text>
                        </View>
                    ))}
                </View>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    header: {
        alignItems: 'center',
        alignSelf: 'stretch',
        flexDirection: 'row',
        gap: 6,
        minHeight: 48,
    },
    pressed: { opacity: 0.6 },
    label: { flexShrink: 1, fontSize: 13, lineHeight: 18 },
    chevronOpen: { transform: [{ rotate: '90deg' }] },
    list: { gap: 8, paddingBottom: 4 },
    item: { gap: 2 },
    text: { fontSize: 13, lineHeight: 18 },
    answer: { opacity: 0.7 },
    skipped: { fontStyle: 'italic' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
