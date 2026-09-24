import type { RefObject } from 'react';
import { useCallback, useRef } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { MobileTheme } from '../../../theme/tokens';
import type { TerminalPreviewViewState } from '../hooks/use-terminal-preview';
import type { MobileSessionItem } from '../session-model';
import type { SessionPreviewPosition } from '../session-preview-scroll';
import { isPreviewAtBottom } from '../session-preview-scroll';
import { sessionTerminalPreviewContent } from '../session-terminal-preview-content';
import { sessionDetailStyles as styles } from './session-detail-styles';

export const SessionTerminalPreview = ({
    previewScrollBySessionRef,
    previewState,
    session,
    theme,
}: {
    previewScrollBySessionRef: RefObject<Partial<Record<string, SessionPreviewPosition>>>;
    previewState: TerminalPreviewViewState;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const previewScroll = useRef<ScrollView>(null);
    const restoredPreviewKeyReference = useRef<string | null>(null);
    const previewKey = `${session.id}:${session.primaryAgentTerminalId ?? 'none'}`;
    const restorePreviewScroll = useCallback((): void => {
        restoredPreviewKeyReference.current = previewKey;
        const position = previewScrollBySessionRef.current[previewKey];
        if (position && !position.isAtBottom)
            previewScroll.current?.scrollTo({ animated: false, y: position.offset });
        else previewScroll.current?.scrollToEnd({ animated: false });
    }, [previewKey, previewScrollBySessionRef]);
    const rememberPreviewScroll = useCallback(
        (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
            if (restoredPreviewKeyReference.current !== previewKey) return;
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
            previewScrollBySessionRef.current[previewKey] = {
                isAtBottom: isPreviewAtBottom(
                    contentOffset.y,
                    layoutMeasurement.height,
                    contentSize.height,
                ),
                offset: contentOffset.y,
            };
        },
        [previewKey, previewScrollBySessionRef],
    );
    const { error: previewError, isLoading: previewLoading, preview, refresh } = previewState;

    return (
        <ScrollView
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
            style={styles.previewPane}
        >
            <Text style={[styles.sectionTitle, { color: theme.muted }]}>LATEST OUTPUT</Text>
            {preview?.truncated ? (
                <Text style={[styles.byteCount, { color: theme.muted }]}>Newest 16 KiB</Text>
            ) : null}
            {previewError ? (
                <View
                    style={[
                        styles.previewError,
                        { backgroundColor: theme.surface, borderColor: theme.border },
                    ]}
                >
                    <Text
                        accessibilityRole="alert"
                        style={[styles.previewErrorText, { color: theme.text }]}
                    >
                        {previewError}
                        {preview ? ' Showing the last known output.' : ''}
                    </Text>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ disabled: previewLoading }}
                        disabled={previewLoading}
                        onPress={refresh}
                        style={styles.previewRetry}
                        testID="terminal-preview-retry"
                    >
                        <Text style={[styles.sendState, { color: theme.primary }]}>Retry</Text>
                    </Pressable>
                </View>
            ) : null}
            <ScrollView
                ref={previewScroll}
                contentContainerStyle={styles.previewContent}
                nestedScrollEnabled
                onContentSizeChange={restorePreviewScroll}
                onScroll={rememberPreviewScroll}
                scrollEventThrottle={16}
                style={[
                    styles.preview,
                    { backgroundColor: theme.surface, borderColor: theme.border },
                ]}
            >
                <Text
                    selectable
                    style={[styles.previewText, { color: theme.text }]}
                    testID={preview?.content ? 'terminal-preview-populated' : 'terminal-preview'}
                >
                    {sessionTerminalPreviewContent(session, previewState)}
                </Text>
            </ScrollView>
        </ScrollView>
    );
};
