/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgentChatWebSource } from '@caxri/protocol';
import { Globe } from 'lucide-react-native';

import { BottomSheet, SheetTitle } from '../../components/bottom-sheet';
import { useTranslation } from '../../i18n';
import { openLink } from '../../lib/open-link';
import { mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { agentChatSourceFavicon, agentChatSourceHost } from './agent-chat-reply-actions';

/**
 * A site's own icon (`/favicon.ico`, requested by the phone directly, as an MCP server's icon is) over a globe that
 * holds the slot while it loads and stays when the site has none. `ring` outlines it in the background color, so
 * overlapping icons read as separate coins.
 */
export const AgentChatSourceFavicon = ({
    ring,
    size,
    theme,
    url,
}: {
    ring?: string;
    size: number;
    theme: MobileTheme;
    url: string;
}) => {
    const [state, setState] = useState<'failed' | 'loaded' | 'loading'>('loading');
    const favicon = agentChatSourceFavicon(url);
    const frame = {
        borderRadius: size / 2,
        height: size,
        width: size,
        backgroundColor: theme.elevated,
        ...(ring && { borderColor: ring, borderWidth: 2 }),
    };
    return (
        <View style={[styles.favicon, frame]}>
            <Globe color={theme.muted} size={size * 0.6} />
            {favicon && state !== 'failed' ? (
                <Image
                    accessibilityIgnoresInvertColors
                    onError={() => setState('failed')}
                    onLoad={() => setState('loaded')}
                    resizeMode="contain"
                    source={{ uri: favicon }}
                    style={[
                        styles.faviconImage,
                        { borderRadius: size / 2 },
                        state === 'loaded' ? null : styles.loading,
                    ]}
                />
            ) : null}
        </View>
    );
};

/**
 * The web pages a turn searched or fetched, listed from its reply's Sources as the ChatGPT app lists them: each page's
 * site over its title, opened in the in-app browser on tap.
 */
export const AgentChatSourcesSheet = ({
    onClose,
    sources,
    theme,
}: {
    onClose: () => void;
    sources: readonly AgentChatWebSource[];
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <BottomSheet
            closeLabel={t('chat.reply.sourcesClose')}
            maxHeight="80%"
            onClose={onClose}
            testID="agent-chat-sources-sheet"
            theme={theme}
        >
            {(dismiss) => (
                <View style={styles.body}>
                    <SheetTitle theme={theme} title={t('chat.reply.sources')} />
                    <ScrollView>
                        {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- A turn's web calls list at most 10 pages each, so a sheet holds tens of rows. */}
                        {sources.map((source, index) => (
                            <Pressable
                                accessibilityRole="link"
                                key={source.url}
                                onPress={() => {
                                    dismiss();
                                    openLink(source.url);
                                }}
                                style={({ pressed }) => [
                                    styles.row,
                                    index > 0 && {
                                        borderTopColor: theme.border,
                                        borderTopWidth: StyleSheet.hairlineWidth,
                                    },
                                    pressed && { backgroundColor: theme.elevated },
                                ]}
                                testID={`agent-chat-source-${index}`}
                            >
                                <View style={styles.site}>
                                    <AgentChatSourceFavicon
                                        size={16}
                                        theme={theme}
                                        url={source.url}
                                    />
                                    <Text
                                        numberOfLines={1}
                                        style={[
                                            mobileType.meta,
                                            styles.host,
                                            { color: theme.muted },
                                        ]}
                                    >
                                        {agentChatSourceHost(source.url)}
                                    </Text>
                                </View>
                                <Text
                                    numberOfLines={3}
                                    style={[mobileType.bodyStrong, { color: theme.text }]}
                                >
                                    {source.title ?? source.url}
                                </Text>
                            </Pressable>
                        ))}
                    </ScrollView>
                </View>
            )}
        </BottomSheet>
    );
};

const styles = StyleSheet.create({
    body: { flexShrink: 1 },
    favicon: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
    faviconImage: { ...StyleSheet.absoluteFill },
    loading: { opacity: 0 },
    row: {
        gap: mobileSpace.xs,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.md,
    },
    site: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.sm },
    host: { flexShrink: 1 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
