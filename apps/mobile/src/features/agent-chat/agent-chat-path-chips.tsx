/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentChatPathReference, AgentChatSkillReference } from '@caxri/protocol';
import { File, Folder, Sparkles } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { agentChatPathChips } from './agent-chat-path-chip-list';

const GLYPHS = { file: File, folder: Folder, skill: Sparkles } as const;

/**
 * The skills and the files and folders a sent user message cites, as pills between its images and its bubble, as
 * Desktop shows them. The phone has no Finder to open them in, so a tap shows the full path under the pills instead.
 */
export const AgentChatPathChips = ({
    references,
    skills,
    theme,
}: {
    references: readonly AgentChatPathReference[];
    skills: readonly AgentChatSkillReference[];
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [shownPath, setShownPath] = useState<string | undefined>();
    const chips = agentChatPathChips(references, skills);
    if (chips.length === 0) return null;
    return (
        <View
            accessibilityLabel={t('chat.pathReference.label')}
            style={styles.root}
            testID="agent-chat-path-chips"
        >
            <View style={styles.chips}>
                {chips.map((chip) => {
                    const Glyph = GLYPHS[chip.kind];
                    const { path } = chip;
                    return (
                        <Pressable
                            accessibilityLabel={
                                path
                                    ? t('chat.pathReference.showPath', { name: chip.name })
                                    : chip.name
                            }
                            accessibilityRole={path ? 'button' : 'text'}
                            disabled={path === undefined}
                            key={chip.key}
                            onPress={() =>
                                setShownPath((current) => (current === path ? undefined : path))
                            }
                            style={[
                                styles.chip,
                                { backgroundColor: theme.elevated, borderColor: theme.border },
                            ]}
                            testID="agent-chat-path-chip"
                        >
                            <Glyph color={theme.muted} size={14} />
                            <Text numberOfLines={1} style={[styles.name, { color: theme.text }]}>
                                {chip.name}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
            {shownPath ? (
                <Text
                    selectable
                    style={[styles.path, { color: theme.muted }]}
                    testID="agent-chat-path-full"
                >
                    {shownPath}
                </Text>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    root: { alignItems: 'flex-end', gap: 4, maxWidth: '85%' },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' },
    chip: {
        alignItems: 'center',
        borderRadius: 16,
        borderWidth: 1,
        flexDirection: 'row',
        gap: 6,
        maxWidth: 240,
        minHeight: 32,
        paddingHorizontal: 10,
    },
    name: { flexShrink: 1, fontSize: 13 },
    path: { fontSize: 12, lineHeight: 17, textAlign: 'right' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
