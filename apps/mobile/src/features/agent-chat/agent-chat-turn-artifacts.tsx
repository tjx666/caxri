/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentChatEditedFile, AgentChatTurnArtifacts as Artifacts } from '@caxri/protocol';
import {
    agentChatEditedFileLines,
    agentChatEditedFilesStat,
    agentChatEditedFilesTitle,
} from '@caxri/protocol';
import { useRecyclingState } from '@shopify/flash-list';
import { ChevronDown, FileDiff } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { ChangesDiffStat } from '../changes/changes-diff-stat';
import { conversationStyles } from '../conversation/conversation-styles';
import { AgentChatFileDiff } from './agent-chat-file-changes';
import { AgentChatTrackerCard } from './agent-chat-tracker-card';

const EditedFile = ({
    file,
    isOnly,
    theme,
}: {
    file: AgentChatEditedFile;
    isOnly: boolean;
    theme: MobileTheme;
}) => {
    const lines = useMemo(() => agentChatEditedFileLines(file), [file]);
    return (
        <AgentChatFileDiff
            initiallyExpanded={isOnly}
            kind={file.kind}
            lines={lines}
            path={file.path}
            theme={theme}
            truncated={file.truncated}
        />
    );
};

/**
 * The files a finished turn changed, as Desktop ends a turn: a glyph tile, `Edited app.ts` or `Edited 3 files` over the
 * turn's `+N -M`, and a tap on the card lists each file with its diff in place. Undo and Review stay on Desktop, which
 * owns the working tree.
 */
const AgentChatEditedFiles = ({
    files,
    theme,
    turnId,
}: {
    files: readonly AgentChatEditedFile[];
    theme: MobileTheme;
    turnId: string;
}) => {
    const { t } = useTranslation();
    // The timeline's FlashList recycles this row for another turn; keyed by turn, the card opens folded there.
    const [isExpanded, setExpanded] = useRecyclingState(false, [turnId]);
    const stat = agentChatEditedFilesStat(files);
    const title = agentChatEditedFilesTitle(files, t);
    return (
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Pressable
                accessibilityLabel={t(
                    isExpanded ? 'chat.changes.hideChanges' : 'chat.changes.viewChanges',
                    { additions: stat.additions, deletions: stat.deletions, title },
                )}
                accessibilityRole="button"
                accessibilityState={{ expanded: isExpanded }}
                onPress={() => setExpanded((current) => !current)}
                style={({ pressed }) => [
                    styles.header,
                    pressed ? { backgroundColor: theme.elevated } : null,
                ]}
                testID={`agent-chat-turn-changes-${turnId}`}
            >
                <View style={[styles.tile, { backgroundColor: theme.background }]}>
                    <FileDiff color={theme.text} size={16} />
                </View>
                <View style={styles.text}>
                    <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
                        {title}
                    </Text>
                    <Text style={[styles.stat, { color: theme.muted }]}>
                        <ChangesDiffStat
                            additions={stat.additions}
                            deletions={stat.deletions}
                            theme={theme}
                        />
                    </Text>
                </View>
                <ChevronDown
                    color={theme.muted}
                    size={16}
                    style={isExpanded ? styles.chevronOpen : null}
                />
            </Pressable>
            {isExpanded ? (
                <View style={styles.files}>
                    {files.map((file) => (
                        <EditedFile
                            file={file}
                            isOnly={files.length === 1}
                            key={file.path}
                            theme={theme}
                        />
                    ))}
                </View>
            ) : null}
        </View>
    );
};

/**
 * What a finished turn left behind, under its final reply: the edited-files card, then a card for each pull request,
 * issue, or acceptance report the Agent filed.
 */
export const AgentChatTurnArtifacts = ({
    artifacts,
    theme,
}: {
    artifacts: Artifacts;
    theme: MobileTheme;
}) => (
    <View style={[conversationStyles.message, styles.root]}>
        {artifacts.files.length > 0 ? (
            <AgentChatEditedFiles files={artifacts.files} theme={theme} turnId={artifacts.turnId} />
        ) : null}
        {artifacts.trackers.map((artifact) => (
            <AgentChatTrackerCard artifact={artifact} key={artifact.url} theme={theme} />
        ))}
    </View>
);

const styles = StyleSheet.create({
    root: { gap: 8 },
    card: { borderRadius: 10, borderWidth: 1, overflow: 'hidden' },
    header: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 12,
        minHeight: 56,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    tile: {
        alignItems: 'center',
        borderRadius: 7,
        height: 36,
        justifyContent: 'center',
        width: 36,
    },
    text: { flex: 1, gap: 2, minWidth: 0 },
    title: { fontSize: 14, lineHeight: 20 },
    stat: { fontSize: 12, fontVariant: ['tabular-nums'], lineHeight: 17 },
    chevronOpen: { transform: [{ rotate: '180deg' }] },
    files: { gap: 8, paddingBottom: 6, paddingHorizontal: 6 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
