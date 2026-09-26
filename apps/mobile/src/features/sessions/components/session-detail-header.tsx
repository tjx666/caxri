import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { LucideIcon } from 'lucide-react-native';
import {
    ChevronLeft,
    EllipsisVertical,
    FileDiff,
    MailOpen,
    MessagesSquare,
    PanelRight,
    SquareTerminal,
} from 'lucide-react-native';

import { AgentGlyph } from '../../../components/agent-icon';
import { IconButton } from '../../../components/icon-button';
import type { MobileTheme } from '../../../theme/tokens';
import { MobileGatewayRequestError } from '../../connection/mobile-gateway-client';
import type { MobileSessionItem } from '../session-model';
import type { SessionSegment } from '../session-ui-state';
import { sessionDetailStyles as styles } from './session-detail-styles';
import { SessionStatusGlyph } from './session-status-glyph';

const segmentPresentation: Record<SessionSegment, { icon: LucideIcon; label: string }> = {
    conversation: { icon: MessagesSquare, label: 'Conversation' },
    terminal: { icon: SquareTerminal, label: 'Terminal' },
    changes: { icon: FileDiff, label: 'Changes' },
    panels: { icon: PanelRight, label: 'Panels' },
};
const segments: SessionSegment[] = ['conversation', 'terminal', 'changes', 'panels'];

/**
 * Only the selected tab spells out its name. Four labelled tabs do not fit a phone at the default font scale, and the
 * icons stay distinct enough once one of them is named; every tab keeps its full accessible name.
 */
const SessionSegmentTab = ({
    changesCount,
    onPress,
    option,
    selected,
    theme,
}: {
    changesCount: number | null;
    onPress: () => void;
    option: SessionSegment;
    selected: boolean;
    theme: MobileTheme;
}) => {
    const { icon: Icon, label } = segmentPresentation[option];
    const count = option === 'changes' && changesCount !== null ? changesCount : null;
    const color = selected ? theme.text : theme.muted;
    return (
        <Pressable
            accessibilityLabel={count === null ? label : `${label}, ${count}`}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={onPress}
            style={[styles.tab, selected ? { backgroundColor: theme.surface } : null]}
            testID={`session-segment-${option}`}
        >
            <Icon color={color} size={18} strokeWidth={selected ? 2.25 : 2} />
            {selected ? (
                <Text numberOfLines={1} style={[styles.tabText, { color }]}>
                    {label}
                </Text>
            ) : null}
            {count === null ? null : (
                <Text
                    style={[
                        styles.tabBadge,
                        {
                            backgroundColor: count > 0 ? theme.elevated : 'transparent',
                            color,
                        },
                    ]}
                    testID="changes-count"
                >
                    {count}
                </Text>
            )}
        </Pressable>
    );
};

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
                        <IconButton
                            accessibilityHint="Returns to the Session list."
                            accessibilityLabel="Back to Sessions"
                            icon={ChevronLeft}
                            onPress={onBack}
                            size={26}
                            testID="session-detail-back"
                            theme={theme}
                        />
                    ) : null}
                    <View style={styles.titleGroup}>
                        <AgentGlyph kind={session.primaryTerminal?.kind} size={18} theme={theme} />
                        <Text
                            accessibilityRole="header"
                            numberOfLines={1}
                            style={[styles.title, { color: theme.text }]}
                        >
                            {session.displayTitle}
                        </Text>
                        <SessionStatusGlyph session={session} theme={theme} />
                    </View>
                    <IconButton
                        accessibilityLabel="Session menu"
                        expanded={isMenuOpen}
                        icon={EllipsisVertical}
                        onPress={() => setMenuOpen((current) => !current)}
                        testID="session-detail-menu"
                        theme={theme}
                    />
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
                            <MailOpen color={theme.muted} size={18} />
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
                    <SessionSegmentTab
                        key={option}
                        changesCount={changesCount}
                        onPress={() => onSegmentChange(option)}
                        option={option}
                        selected={segment === option}
                        theme={theme}
                    />
                ))}
            </View>
        </>
    );
};
