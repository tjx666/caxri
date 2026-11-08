import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import type { LucideIcon } from 'lucide-react-native';
import { FileDiff, PanelRight, X } from 'lucide-react-native';

import { IconButton } from '../../../components/icon-button';
import type { Translate } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import { useHardwareBack } from '../../../lib/use-hardware-back';
import { PRESSED_OPACITY } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import { panelIcon } from '../../panels/panel-icon';
import type { Panel } from '../../panels/use-panels';
import { useDrawerMotion } from '../hooks/use-drawer-motion';
import { useSegmentEntering } from '../hooks/use-segment-entering';
import type { SideSessionSegment } from '../session-ui-state';
import { isPanelSessionSegment, panelIdOfSegment } from '../session-ui-state';
import { sessionSidePanelStyles as styles } from './session-side-panel-styles';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const DRAWER_MS = 220;
/**
 * The selected tab grows to fit its label, so every tab animates its frame instead of snapping its neighbours aside.
 */
const tabLayoutTransition = LinearTransition.duration(200);

const sideSegmentPresentation = (
    segment: SideSessionSegment,
    panels: readonly Panel[] | undefined,
    t: Translate,
): { icon: LucideIcon; label: string } => {
    if (!isPanelSessionSegment(segment))
        return { icon: FileDiff, label: t('sessions.segment.changes') };
    const panel = panels?.find((candidate) => candidate.id === panelIdOfSegment(segment));
    // A view whose title has not loaded yet is still just a view; do not name the internal grouping.
    return { icon: panelIcon(panel?.icon), label: panel?.title ?? t('sessions.segment.view') };
};

/**
 * `session-segment-panel-caxri.files` rather than the raw `panel:` segment, so test ids stay free of separators.
 */
const sideSegmentTestId = (segment: SideSessionSegment): string =>
    isPanelSessionSegment(segment)
        ? `session-segment-panel-${panelIdOfSegment(segment)}`
        : `session-segment-${segment}`;

/**
 * A zero badge reads as a value to act on; an empty Changes view says the same thing without the noise.
 */
const changesBadge = (changesCount: number | null): number | null =>
    changesCount === 0 ? null : changesCount;

/**
 * Only the selected tab spells out its name. Changes plus several Project views do not fit the side panel at the
 * default font scale, and the icons stay distinct enough once one of them is named; every tab keeps its full accessible
 * name.
 */
const SideSegmentTab = ({
    changesCount,
    onPress,
    option,
    panels,
    selected,
    theme,
}: {
    changesCount: number | null;
    onPress: () => void;
    option: SideSessionSegment;
    panels: readonly Panel[] | undefined;
    selected: boolean;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { icon: Icon, label } = sideSegmentPresentation(option, panels, t);
    const count = option === 'changes' ? changesBadge(changesCount) : null;
    const color = selected ? theme.text : theme.muted;
    return (
        <AnimatedPressable
            accessibilityLabel={count === null ? label : `${label}, ${count}`}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            layout={tabLayoutTransition}
            onPress={onPress}
            style={[styles.tab, selected ? { backgroundColor: theme.surface } : null]}
            testID={sideSegmentTestId(option)}
        >
            <Icon color={color} size={18} strokeWidth={selected ? 2.25 : 2} />
            {selected ? (
                <Text numberOfLines={1} style={[styles.tabText, { color }]}>
                    {label}
                </Text>
            ) : null}
            {count === null ? null : (
                <Text
                    style={[styles.tabBadge, { backgroundColor: theme.elevated, color }]}
                    testID="changes-count"
                >
                    {count}
                </Text>
            )}
        </AnimatedPressable>
    );
};

/**
 * The header button that opens the side panel, as Desktop's Toggle Secondary Side Bar does. It carries the changed file
 * count Changes would otherwise show only inside the panel.
 */
export const SessionSidePanelButton = ({
    changesCount,
    isOpen,
    onPress,
    theme,
}: {
    changesCount: number | null;
    isOpen: boolean;
    onPress: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const count = changesBadge(changesCount);
    return (
        <Pressable
            accessibilityLabel={
                count === null
                    ? t('sessions.sidePanel.label')
                    : `${t('sessions.sidePanel.label')}, ${t('sessions.segment.changes')} ${count}`
            }
            accessibilityRole="button"
            accessibilityState={{ expanded: isOpen }}
            hitSlop={4}
            onPress={onPress}
            style={({ pressed }) => [
                styles.panelButton,
                isOpen ? { backgroundColor: theme.surface } : null,
                { opacity: pressed ? PRESSED_OPACITY : 1 },
            ]}
            testID="session-panel-button"
        >
            <PanelRight color={theme.text} size={22} strokeWidth={2} />
            {count === null ? null : (
                <Text
                    numberOfLines={1}
                    style={[
                        styles.panelBadge,
                        {
                            backgroundColor: theme.primary,
                            borderColor: theme.background,
                            color: theme.primaryForeground,
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

/**
 * Registers the drawer's Back before its view mounts. Effects run children first, so a handler in the drawer itself
 * would register after a Files view's and run before it, closing the drawer instead of leaving the open folder.
 * Rendered as the drawer's first child, it registers ahead of the view, and the view's own Back still runs first.
 */
const SidePanelBack = ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => {
    // A drawer sliding out after its owner closed it leaves Back to the screen.
    useHardwareBack(() => {
        if (!isOpen) return false;
        onClose();
        return true;
    });
    return null;
};

/**
 * The side panel: Changes and the Project views behind one button, as Desktop's Secondary Side Bar holds them. A phone
 * draws it as a drawer from the right edge over the whole Session, with a scrim to tap away; a wide tablet docks it
 * beside the content. Either way the content segment stays mounted under or beside it, so closing it returns to the
 * same place in the Chat or Terminal.
 */
export const SessionSidePanel = ({
    changesCount,
    children,
    isAwaitingAnswer,
    isDocked,
    isOpen,
    onClose,
    onExited,
    onSegmentChange,
    panels,
    segment,
    segments,
    theme,
}: {
    changesCount: number | null;
    /**
     * The open view: Changes or the selected Project view.
     */
    children: ReactNode;
    /**
     * See `isChatAwaitingBehindSidePanel`.
     */
    isAwaitingAnswer: boolean;
    isDocked: boolean;
    /**
     * False while a phone's drawer slides out after its owner closed it; a docked panel is always open.
     */
    isOpen: boolean;
    onClose: () => void;
    /**
     * Called once a phone's drawer has slid off screen after closing, so its owner can unmount it.
     */
    onExited: () => void;
    onSegmentChange: (segment: SideSessionSegment) => void;
    panels: readonly Panel[] | undefined;
    segment: SideSessionSegment;
    /**
     * The side panel's tabs in order: Changes, then one per Project view.
     */
    segments: readonly SideSessionSegment[];
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { entering } = useSegmentEntering(segment, segments);
    const drawer = useDrawerMotion({ durationMs: DRAWER_MS, isOpen, onClose, onExited });
    // A docked panel just goes; the drawer slides out first.
    const close = isDocked ? onClose : drawer.close;
    const closeLabel = isAwaitingAnswer
        ? `${t('sessions.sidePanel.close')}, ${t('sessions.segment.awaitingAnswer')}`
        : t('sessions.sidePanel.close');
    const content = (
        <>
            <View style={[styles.header, { borderColor: theme.border }]}>
                {/* Project views join Changes, so the row scrolls rather than squeezing on a narrow phone. */}
                <ScrollView
                    contentContainerStyle={styles.tabs}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.tabScroll}
                >
                    {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- A handful of tabs; virtualizing would only break the row's layout animation. */}
                    {segments.map((option) => (
                        <SideSegmentTab
                            key={option}
                            changesCount={changesCount}
                            onPress={() => onSegmentChange(option)}
                            option={option}
                            panels={panels}
                            selected={segment === option}
                            theme={theme}
                        />
                    ))}
                </ScrollView>
                <View>
                    <IconButton
                        accessibilityLabel={closeLabel}
                        icon={X}
                        onPress={close}
                        testID="session-side-panel-close"
                        theme={theme}
                    />
                    {isAwaitingAnswer ? (
                        <View
                            style={[
                                styles.attentionDot,
                                { backgroundColor: theme.warning, borderColor: theme.background },
                            ]}
                            testID="session-segment-awaiting-answer"
                        />
                    ) : null}
                </View>
            </View>
            <Animated.View entering={entering} key={segment} style={styles.body}>
                {children}
            </Animated.View>
        </>
    );
    if (isDocked)
        return (
            <View
                style={[styles.docked, { borderColor: theme.border }]}
                testID="session-side-panel"
            >
                {content}
            </View>
        );
    return (
        <>
            <Animated.View
                style={[
                    StyleSheet.absoluteFill,
                    { backgroundColor: theme.overlay },
                    drawer.scrimStyle,
                ]}
            >
                {/* The close button is the accessible way out; the scrim is only the tap-away target. */}
                <Pressable
                    accessible={false}
                    importantForAccessibility="no"
                    onPress={close}
                    style={StyleSheet.absoluteFill}
                    testID="session-side-panel-scrim"
                />
            </Animated.View>
            <Animated.View
                accessibilityViewIsModal={isOpen}
                style={[
                    styles.drawer,
                    { backgroundColor: theme.background, borderColor: theme.border },
                    drawer.drawerStyle,
                ]}
                testID="session-side-panel"
            >
                <SidePanelBack isOpen={isOpen} onClose={close} />
                {content}
            </Animated.View>
        </>
    );
};
