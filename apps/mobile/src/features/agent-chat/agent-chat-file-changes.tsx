/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentChatDiffLine, AgentChatFileChange } from '@caxri/protocol';
import {
    agentChatChangeDecoration,
    agentChatChangeKindLabel,
    agentChatDiffLines,
    agentChatDiffLinesStat,
} from '@caxri/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import { MONOSPACE_FONT } from '../../theme/monospace';
import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { ChangesDiffRow } from '../changes/changes-diff-row';
import { ChangesDiffStat } from '../changes/changes-diff-stat';
import { changePathParts, diffLineNumberDigits } from '../changes/changes-model';
import { agentChatChangeColor, agentChatChangeRows } from './agent-chat-timeline';

/**
 * Past this many files, a work row's detail starts with each diff folded so the list of paths reads first, as Desktop's
 * timeline does.
 */
const EXPANDED_FILE_LIMIT = 3;

/**
 * One changed file: its Git status letter in the file's Git color, the path with its directory muted as Desktop draws
 * it (clipped at its start so the file name stays), the `+N -M` stat, and a disclosure for its colored diff, whose long
 * lines wrap so a narrow screen reads the change without panning.
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
    const { t } = useTranslation();
    const [isExpanded, setExpanded] = useState(initiallyExpanded);
    const stat = useMemo(() => agentChatDiffLinesStat(lines), [lines]);
    const rows = useMemo(() => (isExpanded ? agentChatChangeRows(lines) : []), [isExpanded, lines]);
    const digits = useMemo(() => diffLineNumberDigits(rows), [rows]);
    const Chevron = isExpanded ? ChevronDown : ChevronRight;
    const { directory, filename } = changePathParts(path);
    return (
        <View style={[styles.file, { borderColor: theme.border }]}>
            <Pressable
                accessibilityLabel={t(
                    isExpanded ? 'chat.changes.hideDiff' : 'chat.changes.showDiff',
                    {
                        additions: stat.additions,
                        deletions: stat.deletions,
                        kind: agentChatChangeKindLabel(kind, t),
                        path,
                    },
                )}
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
                    {directory ? <Text style={{ color: theme.muted }}>{directory}</Text> : null}
                    {filename}
                </Text>
                {truncated ? (
                    <Text style={[styles.meta, { color: theme.muted }]}>
                        {t('chat.changes.truncated')}
                    </Text>
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
                    <View style={[styles.diff, { borderColor: theme.border }]}>
                        {rows.map((line) => (
                            <ChangesDiffRow
                                key={line.id}
                                line={line}
                                lineNumberDigits={digits}
                                theme={theme}
                            />
                        ))}
                    </View>
                ) : (
                    <Text style={[styles.empty, { color: theme.muted }]}>
                        {t('chat.changes.noDiff')}
                    </Text>
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
    list: { gap: mobileSpace.sm },
    file: { borderRadius: mobileRadius.sm, borderWidth: 1, overflow: 'hidden' },
    header: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        // The header is the file's expand toggle; 48dp is the mobile minimum touch target.
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.md,
    },
    letter: { ...mobileType.caption, fontFamily: MONOSPACE_FONT, fontWeight: '700' },
    path: { ...mobileType.caption, flex: 1, fontFamily: MONOSPACE_FONT, minWidth: 0 },
    meta: { ...mobileType.caption, fontVariant: ['tabular-nums'] },
    diff: { borderTopWidth: 1, paddingVertical: mobileSpace.xs },
    empty: {
        ...mobileType.caption,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.sm,
    },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
