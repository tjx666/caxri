/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { AgentChatItem, AgentChatRequest } from '@caxri/protocol';

import type { MobileTheme } from '../../theme/tokens';
import {
    agentChatApprovalChoices,
    agentChatApprovalFiles,
    agentChatQuestionAnswers,
    agentChatRequestTitle,
} from './agent-chat-model';
import type { AgentChatResponse } from './use-agent-chat';

type QuestionRequest = Extract<AgentChatRequest, { kind: 'question' }>;
type ApprovalRequest = Extract<AgentChatRequest, { kind: 'command' | 'fileChange' }>;

const ActionButton = ({
    disabled,
    label,
    onPress,
    testID,
    theme,
    tone,
}: {
    disabled: boolean;
    label: string;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
    tone: 'primary' | 'danger' | 'plain';
}) => {
    const color =
        tone === 'primary'
            ? theme.primaryForeground
            : tone === 'danger'
              ? theme.danger
              : theme.text;
    return (
        <Pressable
            accessibilityLabel={label}
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onPress}
            style={({ pressed }) => [
                styles.action,
                {
                    backgroundColor:
                        tone === 'primary'
                            ? theme.primary
                            : pressed
                              ? theme.elevated
                              : 'transparent',
                    borderColor:
                        tone === 'primary'
                            ? theme.primary
                            : tone === 'danger'
                              ? theme.danger
                              : theme.border,
                    opacity: disabled ? 0.5 : pressed ? 0.76 : 1,
                },
            ]}
            testID={testID}
        >
            <Text style={[styles.actionLabel, { color }]}>{label}</Text>
        </Pressable>
    );
};

const ApprovalBody = ({
    items,
    request,
    theme,
}: {
    items: readonly AgentChatItem[];
    request: ApprovalRequest;
    theme: MobileTheme;
}) => {
    const files = agentChatApprovalFiles(request, items);
    return (
        <>
            {request.kind === 'command' && request.command ? (
                <Text
                    numberOfLines={6}
                    style={[styles.code, { backgroundColor: theme.elevated, color: theme.text }]}
                    testID="agent-chat-request-command"
                >
                    {request.command}
                </Text>
            ) : null}
            {request.kind === 'command' && request.cwd ? (
                <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
                    in {request.cwd}
                </Text>
            ) : null}
            {files.length > 0 ? (
                <Text numberOfLines={4} style={[styles.meta, { color: theme.muted }]}>
                    {files.join('\n')}
                </Text>
            ) : null}
            {request.reason ? (
                <Text numberOfLines={4} style={[styles.meta, { color: theme.muted }]}>
                    {request.reason}
                </Text>
            ) : null}
        </>
    );
};

/**
 * Test IDs use positions, not provider question IDs or option labels: Android resource IDs only admit lowercase
 * identifiers, and a label is free text.
 */
const QuestionBody = ({
    other,
    request,
    selected,
    setOther,
    setSelected,
    theme,
}: {
    other: Record<string, string>;
    request: QuestionRequest;
    selected: Record<string, string>;
    setOther: (id: string, value: string) => void;
    setSelected: (id: string, value: string) => void;
    theme: MobileTheme;
}) => (
    <>
        {request.questions.map((question, questionIndex) => (
            <View key={question.id} style={styles.question}>
                {question.header ? (
                    <Text style={[styles.header, { color: theme.muted }]}>{question.header}</Text>
                ) : null}
                <Text style={{ color: theme.text }}>{question.question}</Text>
                {question.options.map((option, optionIndex) => {
                    const isSelected =
                        selected[question.id] === option.label && !other[question.id]?.trim();
                    return (
                        <Pressable
                            key={option.label}
                            accessibilityLabel={option.label}
                            accessibilityRole="radio"
                            accessibilityState={{ selected: isSelected }}
                            onPress={() => setSelected(question.id, option.label)}
                            style={[
                                styles.option,
                                {
                                    backgroundColor: isSelected ? theme.elevated : 'transparent',
                                    borderColor: isSelected ? theme.primary : theme.border,
                                },
                            ]}
                            testID={`agent-chat-question-${questionIndex}-option-${optionIndex}`}
                        >
                            <Text style={{ color: theme.text, fontWeight: '600' }}>
                                {option.label}
                            </Text>
                            {option.description ? (
                                <Text style={[styles.meta, { color: theme.muted }]}>
                                    {option.description}
                                </Text>
                            ) : null}
                        </Pressable>
                    );
                })}
                {question.allowsOther || question.options.length === 0 ? (
                    <TextInput
                        accessibilityLabel={`Answer: ${question.question}`}
                        onChangeText={(value) => setOther(question.id, value)}
                        placeholder={question.options.length > 0 ? 'Other answer' : 'Your answer'}
                        placeholderTextColor={theme.muted}
                        style={[
                            styles.input,
                            {
                                backgroundColor: theme.surface,
                                borderColor: theme.border,
                                color: theme.text,
                            },
                        ]}
                        testID={`agent-chat-question-${questionIndex}-other`}
                        value={other[question.id] ?? ''}
                    />
                ) : null}
            </View>
        ))}
    </>
);

/**
 * One pending Chat request: an approval with the decisions the provider offers, or questions with their options. Only a
 * control device answers; others see the request and why they cannot act on it.
 */
export const AgentChatRequestCard = ({
    canAnswer,
    items,
    onRespond,
    request,
    theme,
}: {
    canAnswer: boolean;
    items: readonly AgentChatItem[];
    onRespond: (request: AgentChatRequest, response: AgentChatResponse) => Promise<void>;
    request: AgentChatRequest;
    theme: MobileTheme;
}) => {
    const [selected, setSelected] = useState<Record<string, string>>({});
    const [other, setOther] = useState<Record<string, string>>({});
    const [isSending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const respond = async (response: AgentChatResponse): Promise<void> => {
        setSending(true);
        setError(null);
        try {
            await onRespond(request, response);
        } catch {
            setError('Your answer was not delivered. Try again.');
        } finally {
            setSending(false);
        }
    };
    const isDisabled = !canAnswer || isSending;
    const answers =
        request.kind === 'question' ? agentChatQuestionAnswers(request, selected, other) : null;
    return (
        <View
            style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
            testID="agent-chat-request"
        >
            <Text style={[styles.title, { color: theme.text }]}>
                {agentChatRequestTitle(request)}
            </Text>
            {request.kind === 'question' ? (
                <QuestionBody
                    other={other}
                    request={request}
                    selected={selected}
                    setOther={(id, value) => setOther((current) => ({ ...current, [id]: value }))}
                    setSelected={(id, value) =>
                        setSelected((current) => ({ ...current, [id]: value }))
                    }
                    theme={theme}
                />
            ) : (
                <ApprovalBody items={items} request={request} theme={theme} />
            )}
            {canAnswer ? null : (
                <Text style={[styles.meta, { color: theme.muted }]}>
                    Control access is required to answer this request.
                </Text>
            )}
            {request.kind === 'question' ? (
                <View style={styles.actions}>
                    <ActionButton
                        disabled={isDisabled}
                        label="Skip"
                        onPress={() => {
                            // eslint-disable-next-line no-void -- The card reports a failed answer itself.
                            void respond({ kind: 'decision', decision: 'cancel' });
                        }}
                        testID="agent-chat-question-skip"
                        theme={theme}
                        tone="plain"
                    />
                    <ActionButton
                        disabled={isDisabled || !answers?.isComplete}
                        label="Submit"
                        onPress={() => {
                            if (!answers) return;
                            // eslint-disable-next-line no-void -- The card reports a failed answer itself.
                            void respond({ kind: 'answers', answers: answers.answers });
                        }}
                        testID="agent-chat-question-submit"
                        theme={theme}
                        tone="primary"
                    />
                </View>
            ) : (
                <View style={styles.choices}>
                    {agentChatApprovalChoices(request).map((choice) => (
                        <ActionButton
                            key={choice.decision}
                            disabled={isDisabled}
                            label={choice.label}
                            onPress={() => {
                                // eslint-disable-next-line no-void -- The card reports a failed answer itself.
                                void respond({ kind: 'decision', decision: choice.decision });
                            }}
                            testID={`agent-chat-approval-${choice.decision.toLowerCase()}`}
                            theme={theme}
                            tone={
                                choice.decision === 'accept'
                                    ? 'primary'
                                    : choice.decision === 'decline'
                                      ? 'danger'
                                      : 'plain'
                            }
                        />
                    ))}
                </View>
            )}
            {error ? (
                <Text accessibilityRole="alert" style={[styles.meta, { color: theme.danger }]}>
                    {error}
                </Text>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    card: { borderRadius: 14, borderWidth: 1, gap: 8, padding: 12 },
    title: { fontSize: 15, fontWeight: '700' },
    meta: { fontSize: 13, lineHeight: 18 },
    header: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
    code: {
        borderRadius: 8,
        fontFamily: 'monospace',
        fontSize: 13,
        lineHeight: 18,
        overflow: 'hidden',
        padding: 8,
    },
    question: { gap: 6 },
    option: { borderRadius: 10, borderWidth: 1, gap: 2, minHeight: 44, padding: 10 },
    input: {
        borderRadius: 10,
        borderWidth: 1,
        fontSize: 15,
        minHeight: 44,
        paddingHorizontal: 12,
    },
    actions: { flexDirection: 'row', gap: 12 },
    choices: { gap: 8 },
    action: {
        alignItems: 'center',
        borderRadius: 10,
        borderWidth: 1,
        flex: 1,
        justifyContent: 'center',
        minHeight: 44,
        paddingHorizontal: 12,
    },
    actionLabel: { fontSize: 15, fontWeight: '700' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
