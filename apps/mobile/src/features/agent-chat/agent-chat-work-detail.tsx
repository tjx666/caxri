/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgentChatWorkItem } from '@caxri/protocol';
import {
    agentChatOutputLanguage,
    agentChatReasoningTitle,
    agentChatToolCallArguments,
    agentChatWorkVerb,
    describeAgentChatWork,
    stripLineNumberGutter,
    unwrapShellCommand,
} from '@caxri/protocol';

import { HighlightedCode } from '../../components/highlighted-code';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { ConversationMarkdown } from '../conversation/conversation-markdown';
import { ConversationDetailSheet } from '../conversation/conversation-tool-detail';
import { codeLanguage } from '../panels/file-language';
import { AgentChatFileChanges } from './agent-chat-file-changes';
import { AgentChatTaskDetailBody } from './agent-chat-task-detail';
import { useAgentChatTaskLink } from './agent-chat-task-links';
import { useAgentChatTaskStop } from './use-agent-chat-task-detail';

/**
 * A code block in the detail sheet: syntax colored, selectable, and capped in height so a long output scrolls inside
 * its own box while the sheet's other facts stay in reach.
 */
const CodeBlock = ({
    code,
    language,
    theme,
}: {
    code: string;
    language: string | undefined;
    theme: MobileTheme;
}) => (
    <ScrollView
        nestedScrollEnabled
        style={[styles.code, { backgroundColor: theme.elevated }]}
        testID="agent-chat-work-code"
    >
        <Text selectable style={[styles.codeText, { color: theme.text }]}>
            <HighlightedCode code={code} language={codeLanguage(language)} />
        </Text>
    </ScrollView>
);

const Output = ({
    language,
    text,
    theme,
}: {
    language: string | undefined;
    text: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const output = text.replace(/\n+$/u, '');
    if (!output)
        return (
            <Text style={[styles.note, { color: theme.muted }]}>{t('chat.tasks.noOutput')}</Text>
        );
    return <CodeBlock code={output} language={language} theme={theme} />;
};

/**
 * The detail sheet a Chat work row opens, showing what Desktop shows when the row expands: a thought's text, a
 * command's line, output, exit code, and background hand-off, a tool's arguments and output, or a change's diffs. The
 * title is a command's description when the Agent wrote one.
 */
export const AgentChatWorkDetail = ({
    item,
    onClose,
    theme,
}: {
    item: AgentChatWorkItem | null;
    onClose: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (!item) return null;
    const presentation = describeAgentChatWork(item, t);
    const verb = agentChatWorkVerb(item, presentation, t);
    const title =
        item.type === 'command' && item.description
            ? item.description
            : presentation.subject
              ? `${verb} ${presentation.subject}`
              : verb;
    return (
        <ConversationDetailSheet
            kind={presentation.kind}
            onClose={onClose}
            theme={theme}
            title={title}
        >
            <View style={styles.body}>
                <AgentChatWorkDetailBody item={item} onClose={onClose} theme={theme} />
            </View>
        </ConversationDetailSheet>
    );
};

/**
 * The live side of a background command: the task it became, with its status, Stop, and output tail kept current, as
 * the Background work sheet shows it. Absent once the Chat no longer lists the task, which leaves the output the row
 * captured before it moved to the background.
 */
const BackgroundTask = ({ itemId, theme }: { itemId: string; theme: MobileTheme }) => {
    const link = useAgentChatTaskLink(itemId);
    const stopper = useAgentChatTaskStop(link?.terminalId ?? '');
    const { t } = useTranslation();
    if (!link) return null;
    return (
        <View style={styles.backgroundTask}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>
                {t('chat.work.backgroundOutput')}
            </Text>
            <AgentChatTaskDetailBody
                canControl={link.canControl}
                stopper={stopper}
                task={link.task}
                terminalId={link.terminalId}
                theme={theme}
            />
        </View>
    );
};

const AgentChatWorkDetailBody = ({
    item,
    onClose,
    theme,
}: {
    item: AgentChatWorkItem;
    onClose: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    switch (item.type) {
        case 'reasoning': {
            return (
                <ConversationMarkdown
                    onBeforeOpenLink={onClose}
                    text={agentChatReasoningTitle(item.text).body}
                    theme={theme}
                />
            );
        }
        case 'command': {
            return (
                <>
                    <CodeBlock
                        code={unwrapShellCommand(item.command)}
                        language="bash"
                        theme={theme}
                    />
                    <Output
                        language={agentChatOutputLanguage(item)}
                        text={item.output}
                        theme={theme}
                    />
                    {item.exitCode === undefined ? null : (
                        <Text
                            style={[
                                styles.note,
                                { color: item.exitCode === 0 ? theme.muted : theme.danger },
                            ]}
                        >
                            {t('chat.work.exitCode', { code: item.exitCode })}
                        </Text>
                    )}
                    {item.background ? (
                        <>
                            <Text style={[styles.note, { color: theme.muted }]}>
                                {t('chat.work.movedToBackground')}
                            </Text>
                            <BackgroundTask itemId={item.id} theme={theme} />
                        </>
                    ) : null}
                </>
            );
        }
        case 'toolCall': {
            const output = item.output ?? '';
            const argumentsText = agentChatToolCallArguments(item);
            return (
                <>
                    {argumentsText ? (
                        <Text selectable style={[styles.summary, { color: theme.muted }]}>
                            {argumentsText}
                        </Text>
                    ) : null}
                    <Output
                        language={agentChatOutputLanguage(item)}
                        text={
                            describeAgentChatWork(item).kind === 'read'
                                ? stripLineNumberGutter(output)
                                : output
                        }
                        theme={theme}
                    />
                </>
            );
        }
        case 'fileChange': {
            return <AgentChatFileChanges changes={item.changes} theme={theme} />;
        }
    }
};

const styles = StyleSheet.create({
    body: { gap: 10, paddingBottom: 16, paddingTop: 14 },
    code: { borderRadius: 8, flexGrow: 0, maxHeight: 320 },
    codeText: {
        fontFamily: 'monospace',
        fontSize: 12,
        lineHeight: 18,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    note: { fontSize: 13, lineHeight: 18 },
    backgroundTask: { gap: 4, paddingTop: 6 },
    sectionTitle: { fontSize: 14, fontWeight: '700' },
    summary: { fontFamily: 'monospace', fontSize: 12, lineHeight: 18 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
