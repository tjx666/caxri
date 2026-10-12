/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { useState } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { AgentChatItem, AgentChatRequest, AgentChatResponse } from '@caxri/protocol';
import {
    agentChatApprovalChoices,
    agentChatNextUnansweredQuestion,
    agentChatQuestionAnswers,
    agentChatQuestionDefaults,
    agentChatRequestTitle,
    sentenceStartProvider,
} from '@caxri/protocol';
import { Check } from 'lucide-react-native';

import type { MobileTheme } from '../../theme/tokens';
import type { agentChatRequestBlockedReason } from './agent-chat-model';
import { agentChatApprovalFiles, agentChatApprovalRows } from './agent-chat-model';

type QuestionRequest = Extract<AgentChatRequest, { kind: 'question' }>;
type ApprovalRequest = Extract<AgentChatRequest, { kind: 'command' | 'fileChange' | 'tool' }>;

/**
 * One answer button. `primary` is the filled default answer; every other answer, Decline included, is the outlined
 * ghost style the Desktop request card uses. The pressed button carries its own spinner while its answer is in flight.
 */
const ActionButton = ({
    disabled,
    isPending,
    label,
    onPress,
    testID,
    theme,
    tone,
}: {
    disabled: boolean;
    isPending: boolean;
    label: string;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
    tone: 'primary' | 'plain';
}) => {
    const color = tone === 'primary' ? theme.primaryForeground : theme.text;
    return (
        <Pressable
            accessibilityLabel={label}
            accessibilityRole="button"
            accessibilityState={{ busy: isPending, disabled }}
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
                    borderColor: tone === 'primary' ? theme.primary : theme.border,
                    opacity: disabled && !isPending ? 0.5 : pressed ? 0.76 : 1,
                },
            ]}
            testID={testID}
        >
            {isPending ? (
                <ActivityIndicator color={color} />
            ) : (
                <Text style={[styles.actionLabel, { color }]}>{label}</Text>
            )}
        </Pressable>
    );
};

/**
 * Approval text clamped to `maxLines`, with a Show more / Show less toggle when the clamp hides content, so a long
 * command or plan can still be read before it is accepted.
 */
const ClampedText = ({
    maxLines,
    style,
    testID,
    text,
    theme,
}: {
    maxLines: number;
    style: StyleProp<TextStyle>;
    testID?: string;
    text: string;
    theme: MobileTheme;
}) => {
    const [isExpanded, setExpanded] = useState(false);
    const [isTruncatable, setTruncatable] = useState(false);
    return (
        <View>
            <Text numberOfLines={isExpanded ? undefined : maxLines} style={style} testID={testID}>
                {text}
            </Text>
            {/*
             * An invisible unclamped copy at the same width reports whether the clamp hides anything; a clamped Text's
             * own layout does not say so consistently across platforms, as in `conversation-system-event.tsx`.
             */}
            <Text
                accessible={false}
                importantForAccessibility="no-hide-descendants"
                onTextLayout={({ nativeEvent }) =>
                    setTruncatable(nativeEvent.lines.length > maxLines)
                }
                style={[style, styles.probe]}
            >
                {text}
            </Text>
            {isTruncatable ? (
                <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: isExpanded }}
                    hitSlop={4}
                    onPress={() => setExpanded((current) => !current)}
                    style={styles.toggle}
                    testID={testID ? `${testID}-toggle` : undefined}
                >
                    <Text style={[styles.toggleLabel, { color: theme.primary }]}>
                        {isExpanded ? 'Show less' : 'Show more'}
                    </Text>
                </Pressable>
            ) : null}
        </View>
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
            {request.kind === 'tool' && request.summary ? (
                <ClampedText
                    maxLines={6}
                    style={[styles.code, { backgroundColor: theme.elevated, color: theme.text }]}
                    testID="agent-chat-request-tool"
                    text={request.summary}
                    theme={theme}
                />
            ) : null}
            {request.kind === 'command' && request.command ? (
                <ClampedText
                    maxLines={6}
                    style={[styles.code, { backgroundColor: theme.elevated, color: theme.text }]}
                    testID="agent-chat-request-command"
                    text={request.command}
                    theme={theme}
                />
            ) : null}
            {request.kind === 'command' && request.cwd ? (
                <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
                    in {request.cwd}
                </Text>
            ) : null}
            {files.length > 0 ? (
                <ClampedText
                    maxLines={4}
                    style={[styles.meta, { color: theme.muted }]}
                    testID="agent-chat-request-files"
                    text={files.join('\n')}
                    theme={theme}
                />
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
 * Several questions sit behind `Q1 Q2 Q3` tabs so the card stays one question tall on a phone; a tab carries a check
 * once its question has an answer. Test IDs use positions, not provider question IDs or option labels: Android resource
 * IDs only admit lowercase identifiers, and a label is free text.
 */
const QuestionTabs = ({
    answers,
    index,
    request,
    setIndex,
    theme,
}: {
    answers: Readonly<Record<string, string[]>>;
    index: number;
    request: QuestionRequest;
    setIndex: (index: number) => void;
    theme: MobileTheme;
}) => (
    <View accessibilityRole="tablist" style={styles.tabs}>
        {request.questions.map((question, questionIndex) => {
            const isSelected = questionIndex === index;
            const isAnswered = Object.hasOwn(answers, question.id);
            const color = isSelected ? theme.text : theme.muted;
            return (
                <Pressable
                    key={question.id}
                    accessibilityLabel={[
                        `Question ${questionIndex + 1} of ${request.questions.length}: ${question.header || question.question}`,
                        isAnswered ? 'answered' : 'not answered yet',
                    ].join(', ')}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => setIndex(questionIndex)}
                    style={[
                        styles.tab,
                        { borderBottomColor: isSelected ? theme.primary : 'transparent' },
                    ]}
                    testID={`agent-chat-question-tab-${questionIndex}`}
                >
                    <Text style={[styles.tabLabel, { color }]}>Q{questionIndex + 1}</Text>
                    {isAnswered ? <Check color={theme.success} size={14} /> : null}
                </Pressable>
            );
        })}
    </View>
);

const QuestionBody = ({
    other,
    question,
    questionIndex,
    selected,
    setOther,
    setSelected,
    theme,
}: {
    other: Record<string, string>;
    question: QuestionRequest['questions'][number];
    questionIndex: number;
    selected: Record<string, string>;
    setOther: (id: string, value: string) => void;
    setSelected: (id: string, value: string) => void;
    theme: MobileTheme;
}) => (
    <View style={styles.question}>
        {question.header ? (
            <Text style={[styles.header, { color: theme.muted }]}>{question.header}</Text>
        ) : null}
        <Text style={[styles.questionText, { color: theme.text }]}>{question.question}</Text>
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
                    <Text style={{ color: theme.text, fontWeight: '600' }}>{option.label}</Text>
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
);

/**
 * The buttons and answer state a request body shares with its card: whether answering is possible, which button is in
 * flight, and how to send.
 */
interface RequestActions {
    isDisabled: boolean;
    isShowsActions: boolean;
    pendingAction: string | null;
    respond: (action: string, response: AgentChatResponse) => Promise<void>;
}

/**
 * Questions with their tabs, the current question, and Skip / Submit. `notice` (why answering is blocked) sits between
 * the question and the buttons.
 */
const QuestionContent = ({
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
    const [selected, setSelected] = useState(() => agentChatQuestionDefaults(request));
    const [other, setOther] = useState<Record<string, string>>({});
    const [questionIndex, setQuestionIndex] = useState(0);
    const { answers } = agentChatQuestionAnswers(request, selected, other);
    const question = request.questions.at(questionIndex);
    const answer = (id: string, value: string): void => {
        const nextSelected = { ...selected, [id]: value };
        setSelected(nextSelected);
        /*
         * A tap answers and moves on to the next unanswered question, as the Codex app does. Sending stays with Submit,
         * so a stray tap on a phone never sends the card.
         */
        const next = agentChatNextUnansweredQuestion(
            request,
            agentChatQuestionAnswers(request, nextSelected, other).answers,
            questionIndex,
        );
        if (next !== undefined) setQuestionIndex(next);
    };
    return (
        <>
            {request.questions.length > 1 ? (
                <QuestionTabs
                    answers={answers}
                    index={questionIndex}
                    request={request}
                    setIndex={setQuestionIndex}
                    theme={theme}
                />
            ) : null}
            {question ? (
                <QuestionBody
                    other={other}
                    question={question}
                    questionIndex={questionIndex}
                    selected={selected}
                    setOther={(id, value) => setOther((current) => ({ ...current, [id]: value }))}
                    setSelected={answer}
                    theme={theme}
                />
            ) : null}
            {notice}
            {actions.isShowsActions ? (
                <View style={styles.actions}>
                    <ActionButton
                        disabled={actions.isDisabled}
                        isPending={actions.pendingAction === 'agent-chat-question-skip'}
                        label="Skip"
                        onPress={() => {
                            // eslint-disable-next-line no-void -- The card reports a failed answer itself.
                            void actions.respond('agent-chat-question-skip', {
                                kind: 'decision',
                                decision: 'cancel',
                            });
                        }}
                        testID="agent-chat-question-skip"
                        theme={theme}
                        tone="plain"
                    />
                    <ActionButton
                        disabled={actions.isDisabled || Object.keys(answers).length === 0}
                        isPending={actions.pendingAction === 'agent-chat-question-submit'}
                        label="Submit"
                        onPress={() => {
                            // eslint-disable-next-line no-void -- The card reports a failed answer itself.
                            void actions.respond('agent-chat-question-submit', {
                                kind: 'answers',
                                answers,
                            });
                        }}
                        testID="agent-chat-question-submit"
                        theme={theme}
                        tone="primary"
                    />
                </View>
            ) : null}
        </>
    );
};

/**
 * An approval with the decisions the provider offers, worded by the shared protocol module so the phone reads like the
 * Desktop Chat.
 */
const ApprovalContent = ({
    actions,
    items,
    notice,
    request,
    theme,
}: {
    actions: RequestActions;
    items: readonly AgentChatItem[];
    notice: ReactNode;
    request: ApprovalRequest;
    theme: MobileTheme;
}) => (
    <>
        <ApprovalBody items={items} request={request} theme={theme} />
        {notice}
        {actions.isShowsActions ? (
            <View style={styles.choices}>
                {agentChatApprovalRows(agentChatApprovalChoices(request)).map((row) => (
                    <View key={row[0].decision} style={styles.actions}>
                        {row.map((choice) => {
                            const testID = `agent-chat-approval-${choice.decision.toLowerCase()}`;
                            return (
                                <ActionButton
                                    key={choice.decision}
                                    disabled={actions.isDisabled}
                                    isPending={actions.pendingAction === testID}
                                    label={choice.label}
                                    onPress={() => {
                                        // eslint-disable-next-line no-void -- The card reports a failed answer itself.
                                        void actions.respond(testID, {
                                            kind: 'decision',
                                            decision: choice.decision,
                                        });
                                    }}
                                    testID={testID}
                                    theme={theme}
                                    tone={choice.decision === 'accept' ? 'primary' : 'plain'}
                                />
                            );
                        })}
                    </View>
                ))}
            </View>
        ) : null}
    </>
);

/**
 * One pending Chat request: an approval or questions. Only a connected control device answers. A device without control
 * access sees the request and how to get access, with no buttons it could never press; an offline control device keeps
 * the buttons disabled until it reconnects.
 */
export const AgentChatRequestCard = ({
    blockedReason,
    items,
    onRespond,
    provider,
    request,
    theme,
}: {
    blockedReason: ReturnType<typeof agentChatRequestBlockedReason>;
    items: readonly AgentChatItem[];
    onRespond: (request: AgentChatRequest, response: AgentChatResponse) => Promise<void>;
    provider: string;
    request: AgentChatRequest;
    theme: MobileTheme;
}) => {
    /**
     * The test id of the button whose answer is in flight, so only that button shows a spinner.
     */
    const [pendingAction, setPendingAction] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const actions: RequestActions = {
        isDisabled: blockedReason !== undefined || pendingAction !== null,
        isShowsActions: blockedReason?.kind !== 'access',
        pendingAction,
        respond: async (action, response) => {
            setPendingAction(action);
            setError(null);
            try {
                await onRespond(request, response);
            } catch {
                setError('Your answer was not delivered. Try again.');
            } finally {
                setPendingAction(null);
            }
        },
    };
    const notice = blockedReason ? (
        <Text style={[styles.meta, { color: theme.muted }]} testID="agent-chat-request-blocked">
            {blockedReason.message}
        </Text>
    ) : null;
    return (
        <View
            style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
            testID="agent-chat-request"
        >
            <Text style={[styles.title, { color: theme.text }]}>
                {agentChatRequestTitle(request, sentenceStartProvider(provider))}
            </Text>
            {request.kind === 'question' ? (
                <QuestionContent
                    actions={actions}
                    notice={notice}
                    request={request}
                    theme={theme}
                />
            ) : (
                <ApprovalContent
                    actions={actions}
                    items={items}
                    notice={notice}
                    request={request}
                    theme={theme}
                />
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
    probe: { left: 0, opacity: 0, position: 'absolute', right: 0, top: 0 },
    toggle: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 48, minWidth: 48 },
    toggleLabel: { fontSize: 13, fontWeight: '700' },
    question: { gap: 6 },
    questionText: { fontSize: 15, fontWeight: '600', lineHeight: 21 },
    tabs: { flexDirection: 'row', gap: 4 },
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
    option: { borderRadius: 10, borderWidth: 1, gap: 2, minHeight: 48, padding: 10 },
    input: {
        borderRadius: 10,
        borderWidth: 1,
        fontSize: 15,
        minHeight: 48,
        paddingHorizontal: 12,
    },
    actions: { flexDirection: 'row', gap: 8 },
    choices: { gap: 8 },
    action: {
        alignItems: 'center',
        borderRadius: 10,
        borderWidth: 1,
        flex: 1,
        justifyContent: 'center',
        minHeight: 48,
        paddingHorizontal: 12,
    },
    actionLabel: { fontSize: 15, fontWeight: '700' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
