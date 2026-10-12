/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgentChatDiffLine, AgentChatFileChange } from '@caxri/protocol';
import {
    agentChatChangeDecoration,
    agentChatChangeKindLabel,
    agentChatDiffLines,
    agentChatDiffLinesStat,
} from '@caxri/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react-native';

import type { MobileTheme } from '../../theme/tokens';
import { ChangesDiffRow } from '../changes/changes-diff-row';
import { ChangesDiffStat } from '../changes/changes-diff-stat';
import { agentChatChangeColor, agentChatChangeRows } from './agent-chat-timeline';

/**
 * Past this many files, a work row's detail starts with each diff folded so the list of paths reads first, as Desktop's
 * timeline does.
 */
const EXPANDED_FILE_LIMIT = 3;

/**
 * One changed file: its Git status letter in the file's Git color, the path (clipped at its start so the file name
 * stays), the `+N -M` stat, and a disclosure for its colored diff, which scrolls sideways rather than wrapping code.
 */
export const AgentChatFileDiff = ({
    initiallyExpanded,
    kind,
    lines,
    path,
    theme,
    truncated,
}: {
    initiallyExpanded: boolean;
    kind: AgentChatFileChange['kind'];
    lines: readonly AgentChatDiffLine[];
    path: string;
    theme: MobileTheme;
    truncated: boolean;
}) => {
    const [isExpanded, setExpanded] = useState(initiallyExpanded);
    const stat = useMemo(() => agentChatDiffLinesStat(lines), [lines]);
    const rows = useMemo(() => (isExpanded ? agentChatChangeRows(lines) : []), [isExpanded, lines]);
    const Chevron = isExpanded ? ChevronDown : ChevronRight;
    return (
        <View style={[styles.file, { borderColor: theme.border }]}>
            <Pressable
                accessibilityLabel={`${isExpanded ? 'Hide' : 'Show'} diff: ${path}, ${agentChatChangeKindLabel(kind)}, ${stat.additions} lines added, ${stat.deletions} removed`}
                accessibilityRole="button"
                accessibilityState={{ expanded: isExpanded }}
                onPress={() => setExpanded((current) => !current)}
                style={({ pressed }) => [
                    styles.header,
                    pressed ? { backgroundColor: theme.surface } : null,
                ]}
            >
                <Chevron color={theme.muted} size={14} />
                <Text style={[styles.letter, { color: theme[agentChatChangeColor(kind)] }]}>
                    {agentChatChangeDecoration(kind).letter}
                </Text>
                <Text
                    ellipsizeMode="head"
                    numberOfLines={1}
                    style={[styles.path, { color: theme.text }]}
                >
                    {path}
                </Text>
                {truncated ? (
                    <Text style={[styles.meta, { color: theme.muted }]}>Truncated</Text>
                ) : null}
                <Text style={styles.meta}>
                    <ChangesDiffStat
                        additions={stat.additions}
                        deletions={stat.deletions}
                        theme={theme}
                    />
                </Text>
            </Pressable>
            {isExpanded ? (
                rows.length > 0 ? (
                    <ScrollView
                        contentContainerStyle={styles.diff}
                        horizontal
                        nestedScrollEnabled
                        style={{ borderColor: theme.border, borderTopWidth: 1 }}
                    >
                        <View>
                            {rows.map((line) => (
                                <ChangesDiffRow key={line.id} line={line} theme={theme} />
                            ))}
                        </View>
                    </ScrollView>
                ) : (
                    <Text style={[styles.empty, { color: theme.muted }]}>No diff</Text>
                )
            ) : null}
        </View>
    );
};

/**
 * A file-change item's files, each with its own diff. A few files open expanded; a longer list starts folded.
 */
export const AgentChatFileChanges = ({
    changes,
    theme,
}: {
    changes: readonly AgentChatFileChange[];
    theme: MobileTheme;
}) => (
    <View style={styles.list}>
        {changes.map((change) => (
            <AgentChatFileDiff
                initiallyExpanded={changes.length <= EXPANDED_FILE_LIMIT}
                key={`${change.kind}:${change.path}`}
                kind={change.kind}
                lines={agentChatDiffLines(change)}
                path={change.path}
                theme={theme}
                truncated={change.truncated === true}
            />
        ))}
    </View>
);

const styles = StyleSheet.create({
    list: { gap: 8 },
    file: { borderRadius: 8, borderWidth: 1, overflow: 'hidden' },
    header: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 6,
        // The header is the file's expand toggle; 48dp is the mobile minimum touch target.
        minHeight: 48,
        paddingHorizontal: 10,
    },
    letter: { fontFamily: 'monospace', fontSize: 12, fontWeight: '700' },
    path: { flex: 1, fontFamily: 'monospace', fontSize: 12, minWidth: 0 },
    meta: { fontSize: 12, fontVariant: ['tabular-nums'] },
    diff: { paddingVertical: 4 },
    empty: { fontSize: 12, paddingHorizontal: 10, paddingVertical: 8 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
