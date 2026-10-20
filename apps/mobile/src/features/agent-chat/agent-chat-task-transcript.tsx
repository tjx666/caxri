/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, Text, View } from 'react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { ConversationMarkdown } from '../conversation/conversation-markdown';
import {
    ConversationStatusGlyph,
    ConversationToolIcon,
} from '../conversation/conversation-tool-icon';
import type { AgentChatTaskTranscriptEntry } from './agent-chat-tasks';
import { agentChatWorkRowPresentation } from './agent-chat-work-row';

/**
 * One step of a subagent's work, drawn like a Chat work row (glyph, verb, subject) but read-only: the phone opens one
 * detail sheet at a time, and the subagent's own steps are context for its messages rather than something to drill
 * into.
 */
const TranscriptWork = ({
    entry,
    theme,
}: {
    entry: Extract<AgentChatTaskTranscriptEntry, { kind: 'work' }>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const row = agentChatWorkRowPresentation(entry.item, t);
    return (
        <View
            accessibilityLabel={row.subject ? `${row.verb} ${row.subject}` : row.verb}
            accessible
            style={styles.work}
        >
            <ConversationToolIcon kind={row.kind} theme={theme} />
            <Text numberOfLines={1} style={[styles.workText, { color: theme.muted }]}>
                {row.verb}
                {row.subject ? (
                    <Text
                        style={[{ color: theme.text }, row.isCodeSubject ? styles.code : null]}
                    >{` ${row.subject}`}</Text>
                ) : null}
            </Text>
            {entry.item.type === 'reasoning' ? null : (
                <ConversationStatusGlyph status={entry.item.status} theme={theme} />
            )}
        </View>
    );
};

/**
 * A subagent's transcript in order, as Desktop's task tab shows it: what it said, and the work between.
 */
export const AgentChatTaskTranscript = ({
    entries,
    theme,
}: {
    entries: readonly AgentChatTaskTranscriptEntry[];
    theme: MobileTheme;
}) => (
    <View style={styles.transcript} testID="agent-chat-task-transcript">
        {entries.map((entry) =>
            entry.kind === 'message' ? (
                <View key={entry.id} style={styles.message}>
                    <ConversationMarkdown text={entry.text} theme={theme} />
                </View>
            ) : (
                <TranscriptWork entry={entry} key={entry.id} theme={theme} />
            ),
        )}
    </View>
);

const styles = StyleSheet.create({
    transcript: { gap: 2 },
    message: { paddingVertical: 4 },
    work: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 32 },
    workText: { flex: 1, fontSize: 13, minWidth: 0 },
    code: { fontFamily: 'monospace', fontSize: 12 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
