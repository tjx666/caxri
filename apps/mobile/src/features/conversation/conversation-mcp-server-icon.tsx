/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';

import { McpConnectorIcon } from '../../components/mcp-connector-icon';
import type { MobileTheme } from '../../theme/tokens';

const GLYPH_SIZE = 14;

/**
 * An MCP tool call's glyph: the server's own icon, as Desktop shows it, drawn over the connector glyph. The connector
 * glyph holds the 14dp slot while an icon loads and stays when every URL fails, so a row never changes height or leads
 * with a blank gap. Each URL is tried in turn (`agentChatMcpIconUrls`); one that fails to load falls through to the
 * next.
 */
export const ConversationMcpServerIcon = ({
    theme,
    urls,
}: {
    theme: MobileTheme;
    urls: readonly string[];
}) => {
    const [failedCount, setFailedCount] = useState(0);
    const [loadedUrl, setLoadedUrl] = useState<string | undefined>();
    const url = urls.at(failedCount);
    return (
        <View style={styles.slot}>
            <McpConnectorIcon color={theme.muted} size={GLYPH_SIZE} strokeWidth={2} />
            {url ? (
                <Image
                    accessibilityIgnoresInvertColors
                    key={url}
                    onError={() => setFailedCount((count) => count + 1)}
                    onLoad={() => setLoadedUrl(url)}
                    resizeMode="contain"
                    source={{ uri: url }}
                    style={[styles.icon, loadedUrl === url ? null : styles.loading]}
                    testID="conversation-mcp-server-icon"
                />
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    slot: { height: GLYPH_SIZE, width: GLYPH_SIZE },
    icon: {
        borderRadius: 2,
        height: GLYPH_SIZE,
        left: 0,
        position: 'absolute',
        top: 0,
        width: GLYPH_SIZE,
    },
    loading: { opacity: 0 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
