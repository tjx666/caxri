import { useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import type { MethodResult } from '@caxri/protocol';
import { useQuery } from '@tanstack/react-query';

import type { MobileTheme } from '../../theme/tokens';
import { useMobileClient } from '../connection/mobile-client-provider';
import { AttentionCardChrome, AttentionPermissionActions } from './attention-card-chrome';

type Attention = MethodResult<'mobile.attention.list'>['requests'][number];

const AttentionQuestionFields = ({
    advance,
    canAnswer,
    input,
    question,
    questionCount,
    questionIndex,
    setInput,
    theme,
}: {
    advance: () => Promise<void>;
    canAnswer: boolean;
    input: string;
    question: Attention['questions'][number];
    questionCount: number;
    questionIndex: number;
    setInput: (value: string | ((current: string) => string)) => void;
    theme: MobileTheme;
}) => {
    const selectedLabels = new Set(input.split(',').map((value) => value.trim()));
    return (
        <View style={{ gap: 8 }}>
            <Text style={{ color: theme.text }}>{question.question}</Text>
            {question.options.map((option, optionIndex) => (
                <Pressable
                    accessibilityLabel={option.label}
                    accessibilityRole="button"
                    accessibilityState={{
                        disabled: !canAnswer,
                        selected: selectedLabels.has(option.label),
                    }}
                    disabled={!canAnswer}
                    key={option.label}
                    style={{ minHeight: 44, justifyContent: 'center', paddingVertical: 8 }}
                    testID={`attention-option-${questionIndex}-${optionIndex}`}
                    onPress={() =>
                        setInput((current) => {
                            if (!question.multiSelect) return option.label;
                            const selected = current
                                .split(',')
                                .map((value) => value.trim())
                                .filter(Boolean);
                            return selected.includes(option.label)
                                ? selected.filter((label) => label !== option.label).join(', ')
                                : [...selected, option.label].join(', ');
                        })
                    }
                >
                    <Text style={{ color: theme.primary }}>
                        {option.label}
                        {option.description ? ` · ${option.description}` : ''}
                    </Text>
                </Pressable>
            ))}
            {canAnswer ? (
                <>
                    <TextInput
                        accessibilityLabel="Your answer"
                        onChangeText={setInput}
                        placeholder="Or enter your own answer"
                        placeholderTextColor={theme.muted}
                        style={{
                            color: theme.text,
                            borderColor: theme.border,
                            borderWidth: 1,
                            padding: 8,
                        }}
                        value={input}
                        testID="attention-answer-input"
                    />
                    <Pressable
                        accessibilityLabel={
                            questionIndex + 1 < questionCount ? 'Next question' : 'Submit answers'
                        }
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !input.trim() }}
                        disabled={!input.trim()}
                        testID="attention-answer-next"
                        onPress={advance}
                    >
                        <Text style={{ color: theme.primary }}>
                            {questionIndex + 1 < questionCount ? 'Next' : 'Submit'}
                        </Text>
                    </Pressable>
                </>
            ) : null}
        </View>
    );
};

const AttentionCard = ({
    request: item,
    role,
    submit,
    theme,
}: {
    request: Attention;
    role: 'view' | 'reply' | 'control' | null;
    submit: (
        requestId: string,
        answer: { decision?: 'allow' | 'deny'; answers?: Record<string, string> },
    ) => Promise<void>;
    theme: MobileTheme;
}) => {
    const [questionIndex, setQuestionIndex] = useState(0);
    const answers = useRef<Record<string, string>>({});
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const isPending = item.status === 'pending';
    const canAnswer = isPending && role === 'control' && !busy;
    const question = item.questions.at(questionIndex);
    const send = async (answer: {
        decision?: 'allow' | 'deny';
        answers?: Record<string, string>;
    }) => {
        setBusy(true);
        setError(null);
        try {
            await submit(item.id, answer);
        } catch (error_) {
            setError(
                error_ instanceof Error
                    ? error_.message
                    : 'Unable to answer this request. Open Terminal.',
            );
        } finally {
            setBusy(false);
        }
    };
    const advance = async () => {
        if (!question || !input.trim()) return;
        const next = { ...answers.current, [question.question]: input.trim() };
        answers.current = next;
        if (questionIndex + 1 < item.questions.length) {
            setQuestionIndex(questionIndex + 1);
            setInput(next[item.questions[questionIndex + 1].question] ?? '');
        } else {
            await send({ answers: next });
        }
    };
    return (
        <View
            style={{
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: theme.surface,
                padding: 12,
                gap: 8,
            }}
            testID={`attention-${item.id}`}
        >
            <AttentionCardChrome
                item={item}
                questionIndex={questionIndex}
                role={role}
                theme={theme}
            />
            {canAnswer && item.kind === 'permission' ? (
                <AttentionPermissionActions send={(decision) => send({ decision })} theme={theme} />
            ) : null}
            {question && item.kind === 'question' ? (
                <AttentionQuestionFields
                    advance={advance}
                    canAnswer={canAnswer}
                    input={input}
                    question={question}
                    questionCount={item.questions.length}
                    questionIndex={questionIndex}
                    setInput={setInput}
                    theme={theme}
                />
            ) : null}
            {error ? (
                <Text accessibilityRole="alert" style={{ color: theme.danger }}>
                    {error} Open Terminal if the request is still waiting.
                </Text>
            ) : null}
        </View>
    );
};

export const AttentionCards = ({
    fallbackToTerminal,
    sessionId,
    role,
    theme,
}: {
    fallbackToTerminal?: boolean;
    sessionId: string;
    role: 'view' | 'reply' | 'control' | null;
    theme: MobileTheme;
}) => {
    const { request, connectionScopeKey, isForeground, status } = useMobileClient();
    const attention = useQuery({
        enabled: isForeground && status === 'connected' && connectionScopeKey !== null,
        queryFn: () => request('mobile.attention.list', { sessionId }),
        queryKey: ['mobile', 'attention', connectionScopeKey, sessionId],
        refetchInterval: 1_500,
        retry: false,
    });
    const visible = attention.data?.requests.slice(-3) ?? [];
    if (visible.length === 0)
        return fallbackToTerminal && attention.isSuccess ? (
            <Text style={{ color: theme.muted, padding: 8 }}>
                This Agent's requests need to be handled in Terminal.
            </Text>
        ) : null;
    const submit = async (
        requestId: string,
        answer: { decision?: 'allow' | 'deny'; answers?: Record<string, string> },
    ) => {
        await request('mobile.attention.answer', { sessionId, requestId, ...answer });
        await attention.refetch();
    };
    return (
        <View style={{ gap: 8, padding: 8 }} testID="attention-cards">
            {visible.map((item) => (
                <AttentionCard
                    key={item.id}
                    request={item}
                    role={role}
                    submit={submit}
                    theme={theme}
                />
            ))}
        </View>
    );
};
