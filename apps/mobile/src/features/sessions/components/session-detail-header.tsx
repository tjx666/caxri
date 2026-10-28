import { useCallback, useRef, useState } from 'react';
import type { HostInstance } from 'react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import type { LucideIcon } from 'lucide-react-native';
import {
    ChevronLeft,
    EllipsisVertical,
    FileDiff,
    MailOpen,
    MessagesSquare,
    SquareTerminal,
} from 'lucide-react-native';

import { AgentGlyph } from '../../../components/agent-icon';
import { IconButton } from '../../../components/icon-button';
import { PopoverMenu } from '../../../components/popover-menu';
import { usePopoverAnchor } from '../../../components/use-popover-anchor';
import type { Translate, TranslationKey } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import { isAgentChatTerminal } from '../../agent-chat/agent-chat-model';
import { PreviewChip } from '../../browser/preview-chip';
import { MobileGatewayRequestError } from '../../connection/mobile-gateway-client';
import { panelIcon } from '../../panels/panel-icon';
import type { Panel } from '../../panels/use-panels';
import { PullRequestChip } from '../../pull-request/pull-request-chip';
import { useSavedClock } from '../../read-cache/use-saved-age';
import { segmentForAgentSurface } from '../agent-surface-switch';
import { useAgentSurfaceSwitch } from '../hooks/use-agent-surface-switch';
import type { MobileSessionItem } from '../session-model';
import { sessionStateLabel, sessionTitleForDisplay } from '../session-row-model';
import type { SESSION_SEGMENTS, SessionSegment } from '../session-ui-state';
import {
    isPanelSessionSegment,
    isSegmentAwaitingAnswer,
    panelIdOfSegment,
} from '../session-ui-state';
import {
    AgentSurfaceSwitchMenuAction,
    AgentSurfaceSwitchStatus,
} from './agent-surface-switch-controls';
import { sessionDetailStyles as styles } from './session-detail-styles';
import { SessionStatusGlyph } from './session-status-glyph';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
/**
 * The selected tab grows to fit its label, so every tab animates its frame instead of snapping its neighbours aside.
 */
const tabLayoutTransition = LinearTransition.duration(200);

const fixedSegmentPresentation: Record<
    (typeof SESSION_SEGMENTS)[number],
    { icon: LucideIcon; labelKey: TranslationKey }
> = {
    conversation: { icon: MessagesSquare, labelKey: 'sessions.segment.conversation' },
    terminal: { icon: SquareTerminal, labelKey: 'sessions.segment.terminal' },
    changes: { icon: FileDiff, labelKey: 'sessions.segment.changes' },
};

const segmentPresentation = (
    segment: SessionSegment,
    panels: readonly Panel[] | undefined,
    isChat: boolean,
    t: Translate,
): { icon: LucideIcon; label: string } => {
    // A Chat's conversation tab carries the Desktop name for that surface.
    if (segment === 'conversation' && isChat)
        return { icon: MessagesSquare, label: t('sessions.segment.chat') };
    if (!isPanelSessionSegment(segment)) {
        const { icon, labelKey } = fixedSegmentPresentation[segment];
        return { icon, label: t(labelKey) };
    }
    const panel = panels?.find((candidate) => candidate.id === panelIdOfSegment(segment));
    // A view whose title has not loaded yet is still just a view; do not name the internal grouping.
    return { icon: panelIcon(panel?.icon), label: panel?.title ?? t('sessions.segment.view') };
};

/**
 * `session-segment-panel-caxri.files` rather than the raw `panel:` segment, so test ids stay free of separators.
 */
const segmentTestId = (segment: SessionSegment): string =>
    isPanelSessionSegment(segment)
        ? `session-segment-panel-${panelIdOfSegment(segment)}`
        : `session-segment-${segment}`;

/**
 * Only the selected tab spells out its name. Several labelled tabs do not fit a phone at the default font scale, and
 * the icons stay distinct enough once one of them is named; every tab keeps its full accessible name.
 */
const SessionSegmentTab = ({
    changesCount,
    isAwaitingAnswer,
    isChat,
    onPress,
    option,
    panels,
    selected,
    theme,
}: {
    changesCount: number | null;
    /**
     * See {@link isSegmentAwaitingAnswer}.
     */
    isAwaitingAnswer: boolean;
    isChat: boolean;
    onPress: () => void;
    option: SessionSegment;
    panels: readonly Panel[] | undefined;
    selected: boolean;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { icon: Icon, label } = segmentPresentation(option, panels, isChat, t);
    /**
     * A zero badge reads as a value to act on; an empty Changes tab says the same thing without the noise.
     */
    const count = option === 'changes' && changesCount ? changesCount : null;
    const color = selected ? theme.text : theme.muted;
    return (
        <AnimatedPressable
            accessibilityLabel={[
                label,
                ...(count === null ? [] : [String(count)]),
                ...(isAwaitingAnswer ? [t('sessions.segment.awaitingAnswer')] : []),
            ].join(', ')}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            layout={tabLayoutTransition}
            onPress={onPress}
            style={[styles.tab, selected ? { backgroundColor: theme.surface } : null]}
            testID={segmentTestId(option)}
        >
            <View>
                <Icon color={color} size={18} strokeWidth={selected ? 2.25 : 2} />
                {isAwaitingAnswer ? (
                    <View
                        style={[
                            styles.tabAttentionDot,
                            { backgroundColor: theme.warning, borderColor: theme.background },
                        ]}
                        testID="session-segment-awaiting-answer"
                    />
                ) : null}
            </View>
            {selected ? (
                // A plain Text, not a fading `Animated.Text`: the delayed entering fade left the label at opacity 0
                // whenever the header re-rendered mid-animation (a subagent starting flips the Session to running),
                // so only the icon showed. The tab's own layout transition still animates the width.
                <Text numberOfLines={1} style={[styles.tabText, { color }]}>
                    {label}
                </Text>
            ) : null}
            {count === null ? null : (
                <Text
                    style={[
                        styles.tabBadge,
                        {
                            backgroundColor: theme.elevated,
                            color,
                        },
                    ]}
                    testID="changes-count"
                >
                    {count}
                </Text>
            )}
        </AnimatedPressable>
    );
};

export const SessionDetailHeader = ({
    changesCount,
    deviceRole,
    isCompacting,
    isConnected,
    onBack,
    onMarkRead,
    onSegmentChange,
    panels,
    savedAt,
    segment,
    segments,
    session,
    theme,
}: {
    changesCount: number | null;
    deviceRole: 'view' | 'reply' | 'control' | null;
    /**
     * Whether the Session's Chat is compacting its context; its timeline shows that, so the title does not spin too.
     */
    isCompacting: boolean;
    isConnected: boolean;
    onBack?: () => void;
    onMarkRead: () => Promise<void>;
    onSegmentChange: (segment: SessionSegment) => void;
    panels: readonly Panel[] | undefined;
    /**
     * When `session` comes from the Session list saved on this phone rather than a live read.
     */
    savedAt: number | null;
    segment: SessionSegment;
    /**
     * Visible tabs in order: the fixed segments this Session supports, then one per Project view.
     */
    segments: readonly SessionSegment[];
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const menuAnchor = useRef<HostInstance>(null);
    const menu = usePopoverAnchor(menuAnchor);
    const { close: closeMenu } = menu;
    const [markReadError, setMarkReadError] = useState<string | null>(null);
    const [isTitleExpanded, setTitleExpanded] = useState(false);
    const isChat = isAgentChatTerminal(session.primaryTerminal);
    const now = useSavedClock(savedAt);
    const surfaceSwitch = useAgentSurfaceSwitch(session, (surface) =>
        onSegmentChange(segmentForAgentSurface(surface)),
    );
    /**
     * Reopening the Agent replaces its process and may stop its turn, so only a control device sees it, as with Stop.
     */
    const surfaceTarget = deviceRole === 'control' ? surfaceSwitch.target : null;
    const isSwitchingSurface = surfaceSwitch.pending !== null;
    const handleSwitchSurface = useCallback((): void => {
        closeMenu();
        void surfaceSwitch.switchSurface();
    }, [closeMenu, surfaceSwitch]);
    const handleMarkRead = useCallback(async (): Promise<void> => {
        closeMenu();
        try {
            await onMarkRead();
            setMarkReadError(null);
        } catch (error) {
            setMarkReadError(
                t(
                    error instanceof MobileGatewayRequestError && error.code === 'FORBIDDEN'
                        ? 'sessions.detail.markReadForbidden'
                        : 'sessions.detail.markReadFailed',
                ),
            );
        }
    }, [closeMenu, onMarkRead, t]);
    return (
        <>
            <View style={[styles.header, { borderColor: theme.border }]}>
                <View style={styles.headerLine}>
                    {onBack ? (
                        <IconButton
                            accessibilityHint={t('sessions.detail.backHint')}
                            accessibilityLabel={t('sessions.backToSessions')}
                            icon={ChevronLeft}
                            onPress={onBack}
                            size={26}
                            testID="session-detail-back"
                            theme={theme}
                        />
                    ) : null}
                    <View style={styles.titleGroup}>
                        <AgentGlyph kind={session.primaryTerminal?.kind} size={18} theme={theme} />
                        {/* A long title is cut to one line; tapping it reveals the rest, so it is announced as a toggle. */}
                        <Text
                            accessibilityHint={t(
                                isTitleExpanded
                                    ? 'sessions.detail.collapseTitleHint'
                                    : 'sessions.detail.expandTitleHint',
                            )}
                            accessibilityRole="button"
                            accessibilityState={{ expanded: isTitleExpanded }}
                            numberOfLines={isTitleExpanded ? 3 : 1}
                            onPress={() => setTitleExpanded((current) => !current)}
                            style={[styles.title, { color: theme.text }]}
                            testID="session-detail-title"
                        >
                            {sessionTitleForDisplay(session.title, t)}
                        </Text>
                        <SessionStatusGlyph
                            // The Chat tab's status row already spins for the run, so the title does not spin too.
                            isRunShownBelow={isCompacting || (isChat && segment === 'conversation')}
                            isSaved={savedAt !== null}
                            label={sessionStateLabel(session.stateLabel, savedAt, now, t)}
                            session={session}
                            theme={theme}
                        />
                    </View>
                    <PreviewChip deviceRole={deviceRole} sessionId={session.id} theme={theme} />
                    <PullRequestChip
                        deviceRole={deviceRole}
                        isConnected={isConnected}
                        sessionId={session.id}
                        theme={theme}
                    />
                    <View collapsable={false} ref={menuAnchor}>
                        <IconButton
                            accessibilityLabel={t('sessions.detail.menu')}
                            expanded={menu.isOpen}
                            icon={EllipsisVertical}
                            onPress={menu.open}
                            testID="session-detail-menu"
                            theme={theme}
                        />
                    </View>
                </View>
                <PopoverMenu
                    closeLabel={t('sessions.detail.closeMenu')}
                    onClose={closeMenu}
                    placement={menu.placement}
                    theme={theme}
                >
                    {surfaceTarget ? (
                        <AgentSurfaceSwitchMenuAction
                            isDisabled={!isConnected || isSwitchingSurface}
                            onPress={handleSwitchSurface}
                            target={surfaceTarget}
                            theme={theme}
                        />
                    ) : null}
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
                            {t('sessions.detail.markRead')}
                        </Text>
                    </Pressable>
                    {!isConnected ? (
                        <Text style={[styles.sendState, { color: theme.muted }]}>
                            {t('sessions.detail.reconnectForActions')}
                        </Text>
                    ) : null}
                </PopoverMenu>
                <AgentSurfaceSwitchStatus
                    error={surfaceSwitch.error}
                    pending={surfaceSwitch.pending}
                    theme={theme}
                />
                {markReadError ? (
                    <Text
                        accessibilityRole="alert"
                        style={[styles.sendState, { color: theme.danger }]}
                    >
                        {markReadError}
                    </Text>
                ) : null}
            </View>
            {/* Project views join the fixed tabs, so the strip scrolls rather than squeezing on a narrow phone. */}
            <ScrollView
                contentContainerStyle={styles.tabs}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={[styles.tabStrip, { borderColor: theme.border }]}
            >
                {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- A handful of tabs; virtualizing would only break the strip's layout animation. */}
                {segments.map((option) => (
                    <SessionSegmentTab
                        key={option}
                        changesCount={changesCount}
                        isAwaitingAnswer={isSegmentAwaitingAnswer({
                            isChat,
                            isSelected: segment === option,
                            agentActivityState: session.agentActivityState,
                            segment: option,
                        })}
                        isChat={isChat}
                        onPress={() => onSegmentChange(option)}
                        option={option}
                        panels={panels}
                        selected={segment === option}
                        theme={theme}
                    />
                ))}
            </ScrollView>
        </>
    );
};
