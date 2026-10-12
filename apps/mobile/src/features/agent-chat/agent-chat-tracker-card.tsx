/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ComponentType } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import type { AgentChatTrackerArtifact } from '@caxri/protocol';
import { trackerExcerptText, trackerReferenceText } from '@caxri/protocol';
import type { LucideProps } from 'lucide-react-native';
import {
    ArrowUpRight,
    CircleDot,
    ClipboardCheck,
    GitPullRequest,
    ListChecks,
} from 'lucide-react-native';

import { openExternalLink } from '../../lib/open-external-link';
import type { MobileTheme } from '../../theme/tokens';

interface MarkProperties {
    color: string;
    size: number;
}

/**
 * GitHub's `mark-github` Octicon (MIT, https://github.com/primer/octicons), the same path Desktop draws, in the text
 * color so it stays visible on the dark theme.
 */
const GithubMark = ({ color, size }: MarkProperties) => (
    <Svg fill={color} height={size} viewBox="0 0 16 16" width={size}>
        <Path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </Svg>
);

/**
 * Linear's logomark (https://linear.app/brand), the same path Desktop draws.
 */
const LinearMark = ({ color, size }: MarkProperties) => (
    <Svg fill={color} height={size} viewBox="0 0 100 100" width={size}>
        <Path d="M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L39.3342 97.1782c.6889.6889.0915 1.8189-.857 1.5964C20.0515 94.4522 5.54779 79.9485 1.22541 61.5228ZM.00189135 46.8891c-.01764375.2833.08887215.5599.28957165.7606L52.3503 99.7085c.2007.2007.4773.3075.7606.2896 2.3692-.1476 4.6938-.46 6.9624-.9259.7645-.157 1.0301-1.0963.4782-1.6481L2.57595 39.4485c-.55186-.5519-1.49117-.2863-1.648174.4782-.465915 2.2686-.77832 4.5932-.92588465 6.9624ZM4.21093 29.7054c-.16649.3738-.08169.8106.20765 1.1l64.77602 64.776c.2894.2894.7262.3742 1.1.2077 1.7861-.7956 3.5171-1.6927 5.1855-2.684.5521-.328.6373-1.0867.1832-1.5407L8.43566 24.3367c-.45409-.4541-1.21271-.3689-1.54074.1832-.99132 1.6684-1.88843 3.3994-2.68399 5.1855ZM12.6587 18.074c-.3701-.3701-.393-.9637-.0443-1.3541C21.7795 6.45931 35.1114 0 49.9519 0 77.5927 0 100 22.4073 100 50.0481c0 14.8405-6.4593 28.1724-16.7199 37.3375-.3903.3487-.984.3258-1.3542-.0443L12.6587 18.074Z" />
    </Svg>
);

const ClipboardMark = ({ color, size }: MarkProperties) => (
    <ClipboardCheck color={color} size={size} />
);

/**
 * The tile mark for each provider. LobeHub has no logomark here, so an acceptance report shows a checked clipboard, as
 * on Desktop.
 */
const PROVIDER_MARK: Record<AgentChatTrackerArtifact['provider'], ComponentType<MarkProperties>> = {
    github: GithubMark,
    linear: LinearMark,
    lobehub: ClipboardMark,
};

const KIND_ICON: Record<AgentChatTrackerArtifact['kind'], ComponentType<LucideProps>> = {
    pull: GitPullRequest,
    issue: CircleDot,
    acceptance: ListChecks,
};

const KIND_LABEL: Record<AgentChatTrackerArtifact['kind'], string> = {
    pull: 'pull request',
    issue: 'issue',
    acceptance: 'acceptance report',
};

/**
 * A pull request, issue, or acceptance report the Agent created or edited this turn, as Desktop's tracker card: the
 * tracker's mark in a tile, the title beside its reference, the body's first line, and what was done to it with an
 * external arrow, since a tap opens the page in the browser.
 */
export const AgentChatTrackerCard = ({
    artifact,
    theme,
}: {
    artifact: AgentChatTrackerArtifact;
    theme: MobileTheme;
}) => {
    const Mark = PROVIDER_MARK[artifact.provider];
    const KindIcon = KIND_ICON[artifact.kind];
    const label = `${artifact.action === 'created' ? 'Created' : 'Updated'} ${KIND_LABEL[artifact.kind]}`;
    // An acceptance round ingested without a readable title names the report rather than promoting `Round N`.
    const title =
        artifact.title ?? (artifact.kind === 'acceptance' ? 'Acceptance report' : undefined);
    const reference = trackerReferenceText(artifact);
    const excerpt = trackerExcerptText(artifact);
    return (
        <Pressable
            accessibilityLabel={`${label}: ${title ?? reference}, ${reference}. Open in browser`}
            accessibilityRole="link"
            onPress={() => {
                // eslint-disable-next-line no-void -- openExternalLink reports a refused link itself.
                void openExternalLink(artifact.url);
            }}
            style={({ pressed }) => [
                styles.card,
                {
                    backgroundColor: pressed ? theme.elevated : theme.surface,
                    borderColor: theme.border,
                },
            ]}
            testID={`agent-chat-tracker-${artifact.reference}`}
        >
            <View style={[styles.tile, { backgroundColor: theme.background }]}>
                <Mark color={theme.text} size={16} />
            </View>
            <View style={styles.text}>
                <View style={styles.titleRow}>
                    <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
                        {title ?? reference}
                    </Text>
                    {title ? (
                        <Text style={[styles.reference, { color: theme.muted }]}>{reference}</Text>
                    ) : null}
                </View>
                {excerpt ? (
                    <Text numberOfLines={1} style={[styles.excerpt, { color: theme.muted }]}>
                        {excerpt}
                    </Text>
                ) : null}
                <View style={styles.action}>
                    <KindIcon color={theme.muted} size={13} />
                    <Text style={[styles.excerpt, { color: theme.muted }]}>{label}</Text>
                    <ArrowUpRight color={theme.muted} size={13} />
                </View>
            </View>
        </Pressable>
    );
};

const styles = StyleSheet.create({
    card: {
        alignItems: 'center',
        borderRadius: 10,
        borderWidth: 1,
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
    titleRow: { alignItems: 'baseline', flexDirection: 'row', gap: 8, minWidth: 0 },
    title: { flexShrink: 1, fontSize: 14, lineHeight: 20 },
    reference: { flexShrink: 0, fontFamily: 'monospace', fontSize: 11 },
    excerpt: { fontSize: 12, lineHeight: 17 },
    action: { alignItems: 'center', flexDirection: 'row', gap: 4 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
