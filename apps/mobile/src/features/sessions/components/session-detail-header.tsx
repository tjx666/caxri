import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { MobileTheme } from '../../../theme/tokens';
import { MobileGatewayRequestError } from '../../connection/mobile-gateway-client';
import type { MobileSessionItem } from '../session-model';
import type { SessionSegment } from '../session-ui-state';
import { sessionDetailStyles as styles } from './session-detail-styles';

const segmentLabels: Record<SessionSegment, string> = {
    conversation: 'Conversation',
    terminal: 'Terminal',
    changes: 'Changes',
};
const segments: SessionSegment[] = ['conversation', 'terminal', 'changes'];

export const SessionDetailHeader = ({
    changesCount,
    isConnected,
    onBack,
    onMarkRead,
    onSegmentChange,
    segment,
    session,
    theme,
}: {
    changesCount: number | null;
    isConnected: boolean;
    onBack?: () => void;
    onMarkRead: () => Promise<void>;
    onSegmentChange: (segment: SessionSegment) => void;
    segment: SessionSegment;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const [isMenuOpen, setMenuOpen] = useState(false);
    const [markReadError, setMarkReadError] = useState<string | null>(null);
    const handleMarkRead = useCallback(async (): Promise<void> => {
        setMenuOpen(false);
        try {
            await onMarkRead();
            setMarkReadError(null);
        } catch (error) {
            setMarkReadError(
                error instanceof MobileGatewayRequestError && error.code === 'FORBIDDEN'
                    ? 'This device cannot mark Sessions as read. Pair it again on your computer to grant control.'
                    : 'Unable to mark this Session as read.',
            );
        }
    }, [onMarkRead]);
    return (
        <>
            <View style={[styles.header, { borderColor: theme.border }]}>
                <View style={styles.headerLine}>
                    {onBack ? (
                        <Pressable
                            accessibilityHint="Returns to the Session list."
                            accessibilityLabel="Back to Sessions"
                            accessibilityRole="button"
                            onPress={onBack}
                            style={styles.back}
                            testID="session-detail-back"
                        >
                            <Text style={[styles.backText, { color: theme.text }]}>←</Text>
                        </Pressable>
                    ) : null}
                    <Text
                        accessibilityRole="header"
                        numberOfLines={1}
                        style={[styles.title, { color: theme.text }]}
                    >
                        {session.displayTitle}
                    </Text>
                    <Text numberOfLines={1} style={[styles.state, { color: theme.muted }]}>
                        {session.stateLabel}
                    </Text>
                    <Pressable
                        accessibilityLabel="Session menu"
                        accessibilityRole="button"
                        accessibilityState={{ expanded: isMenuOpen }}
                        onPress={() => setMenuOpen((current) => !current)}
                        style={styles.menuButton}
                        testID="session-detail-menu"
                    >
                        <Text style={[styles.menuText, { color: theme.muted }]}>⋯</Text>
                    </Pressable>
                </View>
                {isMenuOpen ? (
                    <View
                        style={[
                            styles.menu,
                            { backgroundColor: theme.surface, borderColor: theme.border },
                        ]}
                    >
                        <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ disabled: !isConnected }}
                            disabled={!isConnected}
                            onPress={handleMarkRead}
                            style={styles.menuAction}
                            testID="session-mark-read"
                        >
                            <Text
                                style={[
                                    styles.menuActionText,
                                    { color: isConnected ? theme.text : theme.muted },
                                ]}
                            >
                                Mark read
                            </Text>
                        </Pressable>
                        {!isConnected ? (
                            <Text style={[styles.sendState, { color: theme.muted }]}>
                                Reconnect to mark read.
                            </Text>
                        ) : null}
                    </View>
                ) : null}
                {markReadError ? (
                    <Text
                        accessibilityRole="alert"
                        style={[styles.sendState, { color: theme.danger }]}
                    >
                        {markReadError}
                    </Text>
                ) : null}
            </View>
            <View style={[styles.tabs, { borderColor: theme.border }]}>
                {segments.map((option) => (
                    <Pressable
                        key={option}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: segment === option }}
                        onPress={() => onSegmentChange(option)}
                        style={[
                            styles.tab,
                            { borderColor: segment === option ? theme.primary : 'transparent' },
                        ]}
                        testID={`session-segment-${option}`}
                    >
                        <Text
                            style={[
                                styles.tabText,
                                { color: segment === option ? theme.text : theme.muted },
                            ]}
                            testID={option === 'changes' ? 'changes-count' : undefined}
                        >
                            {segmentLabels[option]}
                            {option === 'changes' && changesCount !== null
                                ? ` ${changesCount}`
                                : ''}
                        </Text>
                    </Pressable>
                ))}
            </View>
        </>
    );
};
