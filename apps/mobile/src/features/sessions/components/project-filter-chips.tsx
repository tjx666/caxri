/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import type { SharedValue } from 'react-native-reanimated';
import Animated, {
    scrollTo,
    useAnimatedRef,
    useAnimatedStyle,
    useDerivedValue,
    useFrameCallback,
    useScrollOffset,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { Chip } from '../../../components/chip';
import { useTranslation } from '../../../i18n';
import { mobileRadius, mobileSpace } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import type { ProjectChipSlot } from '../project-order';
import {
    projectAutoScrollStep,
    projectChipIndicator,
    projectChipRevealOffset,
    projectChipShift,
    projectDropIndex,
    projectMoveActions,
    projectMoveTarget,
} from '../project-order';
import { PAGER_SETTLE } from './project-pager-motion';

/**
 * Holding a chip this long picks it up; a shorter touch stays a tap, and moving first scrolls the strip.
 */
const PICK_UP_DELAY_MS = 300;
/**
 * A held chip within this distance of either end of the strip scrolls it, up to `AUTO_SCROLL_MAX_STEP` per frame.
 */
const AUTO_SCROLL_EDGE = 48;
const AUTO_SCROLL_MAX_STEP = 8;
/**
 * A held chip must move this far toward an edge before that edge scrolls the strip.
 */
const AUTO_SCROLL_SLOP = 8;
const SETTLE_MS = 150;
const CHIP_GAP = mobileSpace.sm;
/**
 * Wider than any chip, so an unmeasured chip's highlight covers its whole pill.
 */
const UNMEASURED_FILL_WIDTH = 10_000;

/**
 * The drag one held chip is making, shared by every chip so the others can step aside.
 */
interface ChipDrag {
    /**
     * The held chip's index, or -1 when no chip is held.
     */
    from: SharedValue<number>;
    /**
     * Where the held chip would land if it were released now.
     */
    to: SharedValue<number>;
    translation: SharedValue<number>;
    /**
     * The strip's scroll offset when the chip was picked up, so auto-scroll carries the chip along with the finger.
     */
    scrollStart: SharedValue<number>;
    scrollOffset: SharedValue<number>;
    slots: SharedValue<ProjectChipSlot[]>;
    /**
     * The chip order the held chip was picked up in. Offsets apply only to chips laid out in that order.
     */
    order: SharedValue<string>;
}

export interface ProjectFilterChoice {
    id: string;
    title: string;
}

/**
 * The Project filters above the Session list: All, then each Project in the order Desktop's sidebar shows. On a control
 * device a held Project chip can be dragged to a new place, as the sidebar's Projects can; the strip scrolls when the
 * chip is held near either end.
 */
export const ProjectFilterChips = ({
    activeProjectId,
    onChooseProject,
    onMoveProject,
    pageProgress,
    projects,
    theme,
}: {
    activeProjectId: string | null;
    onChooseProject: (projectId: string | null) => void;
    /**
     * Present only for a control device; without it the chips only filter.
     */
    onMoveProject?: (projectId: string, toIndex: number) => void;
    /**
     * The Project pager's place in pages (0 is All, then each Project). The highlight follows it while a swipe drags or
     * settles the pager; at rest the strip sets it, gliding there when another chip is chosen.
     */
    pageProgress: SharedValue<number>;
    projects: ProjectFilterChoice[];
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const allSlot = useSharedValue<ProjectChipSlot | undefined>(undefined);
    const scrollReference = useAnimatedRef<Animated.ScrollView>();
    const scrollOffset = useScrollOffset(scrollReference);
    const viewportWidth = useSharedValue(0);
    const contentWidth = useSharedValue(0);
    const drag: ChipDrag = {
        from: useSharedValue(-1),
        to: useSharedValue(-1),
        translation: useSharedValue(0),
        scrollStart: useSharedValue(0),
        scrollOffset,
        slots: useSharedValue<ProjectChipSlot[]>([]),
        order: useSharedValue(''),
    };
    const slotsReference = useRef<ProjectChipSlot[]>([]);
    const [isDragging, setDragging] = useState(false);
    const autoScroll = useFrameCallback(() => {
        const from = drag.from.get();
        if (from < 0) return;
        const slot = drag.slots.get().at(from);
        if (!slot) return;
        const offset = scrollOffset.get();
        const step = projectAutoScrollStep({
            chipLeft: slot.x + drag.translation.get() - drag.scrollStart.get(),
            chipWidth: slot.width,
            edge: AUTO_SCROLL_EDGE,
            maxOffset: Math.max(0, contentWidth.get() - viewportWidth.get()),
            maxStep: AUTO_SCROLL_MAX_STEP,
            offset,
            slop: AUTO_SCROLL_SLOP,
            translation: drag.translation.get(),
            viewportWidth: viewportWidth.get(),
        });
        if (step === 0) return;
        scrollTo(scrollReference, offset + step, 0, false);
        drag.to.set(
            projectDropIndex(
                drag.slots.get(),
                from,
                slot.x +
                    slot.width / 2 +
                    drag.translation.get() +
                    offset +
                    step -
                    drag.scrollStart.get(),
            ),
        );
    }, false);
    const { setActive } = autoScroll;
    useEffect(() => setActive(isDragging), [isDragging, setActive]);
    const projectOrder = projects.map(({ id }) => id).join('\n');
    // A move re-renders the chips in their new places; only then may the held chip and its neighbors drop their offsets,
    // or the strip would flash the old order for a frame. Resetting them still reaches the UI thread a frame after the
    // new layout, so each chip is also keyed by the order: a chip mounted in another order than the drag's draws no
    // offset from its first frame, instead of carrying the old offset into its new place.
    useLayoutEffect(() => {
        slotsReference.current = slotsReference.current.slice(0, projects.length);
        drag.slots.set(slotsReference.current);
        drag.from.set(-1);
        drag.to.set(-1);
        drag.translation.set(0);
    }, [drag.from, drag.slots, drag.to, drag.translation, projectOrder, projects.length]);
    const activeIndex = projects.findIndex(({ id }) => id === activeProjectId);
    const shownProjectId = useRef(activeProjectId);
    // Choosing another chip glides the highlight there. A settled swipe already carried it there, so the same glide
    // changes nothing; a Project reorder keeps the selection and only moves its chip, so the highlight follows at once.
    useEffect(() => {
        const page = activeIndex + 1;
        if (shownProjectId.current === activeProjectId) pageProgress.set(page);
        else pageProgress.set(withTiming(page, PAGER_SETTLE));
        shownProjectId.current = activeProjectId;
    }, [activeIndex, activeProjectId, pageProgress]);
    // Swiping the Session list can select a chip past the edge of the strip, so the strip follows the selection.
    useEffect(() => {
        const offset = projectChipRevealOffset(
            activeIndex === -1 ? undefined : slotsReference.current.at(activeIndex),
            viewportWidth.get(),
            contentWidth.get(),
        );
        scrollReference.current?.scrollTo({ animated: true, x: offset });
    }, [activeIndex, contentWidth, scrollReference, viewportWidth]);
    const drop = useCallback(
        (projectId: string, from: number, to: number) => {
            setDragging(false);
            if (from === to || !onMoveProject) {
                drag.from.set(-1);
                drag.translation.set(0);
                return;
            }
            onMoveProject(projectId, to);
        },
        [drag.from, drag.translation, onMoveProject],
    );
    const measure = useCallback(
        (index: number, event: LayoutChangeEvent) => {
            const { width, x } = event.nativeEvent.layout;
            const next = [...slotsReference.current];
            next[index] = { width, x };
            slotsReference.current = next;
            drag.slots.set(next);
        },
        [drag.slots],
    );
    return (
        <Animated.ScrollView
            contentContainerStyle={styles.chips}
            horizontal
            onContentSizeChange={(width) => {
                contentWidth.set(width);
            }}
            onLayout={(event) => {
                viewportWidth.set(event.nativeEvent.layout.width);
            }}
            ref={scrollReference}
            scrollEnabled={!isDragging}
            showsHorizontalScrollIndicator={false}
            style={styles.scroll}
            testID="session-project-filters"
        >
            <Animated.View
                onLayout={(event) => {
                    const { width, x } = event.nativeEvent.layout;
                    allSlot.set({ width, x });
                }}
            >
                <Chip
                    accessibilityLabel={t('sessions.home.allProjectsLabel')}
                    label={t('sessions.home.allProjects')}
                    onPress={() => onChooseProject(null)}
                    selected={activeProjectId === null}
                    selectionFill={(selectedContent) => (
                        <ChipSelectionFill
                            allSlot={allSlot}
                            page={0}
                            pageProgress={pageProgress}
                            selectedContent={selectedContent}
                            slots={drag.slots}
                            theme={theme}
                        />
                    )}
                    testID="project-filter-all"
                    theme={theme}
                />
            </Animated.View>
            {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- A Mac has a handful of Projects, and a virtualized cell would measure each chip in its own cell instead of along the strip, which the drag needs. */}
            {projects.map((project, index) => (
                <ProjectChip
                    key={`${project.id}\n${projectOrder}`}
                    allSlot={allSlot}
                    drag={drag}
                    index={index}
                    onChoose={onChooseProject}
                    onDragStart={() => setDragging(true)}
                    onDrop={drop}
                    onLayout={measure}
                    onMove={onMoveProject}
                    order={projectOrder}
                    pageProgress={pageProgress}
                    projectCount={projects.length}
                    project={project}
                    reorderHint={onMoveProject ? t('sessions.home.projectReorderHint') : undefined}
                    selected={activeProjectId === project.id}
                    theme={theme}
                />
            ))}
        </Animated.ScrollView>
    );
};

const ProjectChip = ({
    allSlot,
    drag,
    index,
    onChoose,
    onDragStart,
    onDrop,
    onLayout,
    onMove,
    order,
    pageProgress,
    project,
    projectCount,
    reorderHint,
    selected,
    theme,
}: {
    allSlot: SharedValue<ProjectChipSlot | undefined>;
    drag: ChipDrag;
    index: number;
    onChoose: (projectId: string) => void;
    onDragStart: () => void;
    onDrop: (projectId: string, from: number, to: number) => void;
    onLayout: (index: number, event: LayoutChangeEvent) => void;
    onMove?: (projectId: string, toIndex: number) => void;
    /**
     * The chip order this chip was laid out in.
     */
    order: string;
    pageProgress: SharedValue<number>;
    project: ProjectFilterChoice;
    projectCount: number;
    /**
     * Present only when the chip can be dragged.
     */
    reorderHint?: string;
    selected: boolean;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { from, order: dragOrder, scrollOffset, scrollStart, slots, to, translation } = drag;
    // A drag needs a held touch and fine motor control, so a screen reader moves the chip one place at a time instead.
    const moveActions = projectMoveActions(index, projectCount, {
        earlier: t('sessions.home.projectMoveEarlier'),
        later: t('sessions.home.projectMoveLater'),
    });
    const pan = usePanGesture({
        activateAfterLongPress: PICK_UP_DELAY_MS,
        enabled: reorderHint !== undefined,
        onActivate: () => {
            from.set(index);
            to.set(index);
            translation.set(0);
            dragOrder.set(order);
            scrollStart.set(scrollOffset.get());
            scheduleOnRN(onDragStart);
        },
        onUpdate: (event) => {
            const slot = slots.get().at(index);
            if (!slot) return;
            translation.set(event.translationX);
            to.set(
                projectDropIndex(
                    slots.get(),
                    index,
                    slot.x +
                        slot.width / 2 +
                        event.translationX +
                        scrollOffset.get() -
                        scrollStart.get(),
                ),
            );
        },
        onDeactivate: () => {
            const slot = slots.get().at(index);
            const target = slots.get().at(to.get());
            const landing = to.get();
            if (!slot || !target || landing === index) {
                translation.set(
                    withTiming(0, { duration: SETTLE_MS }, () =>
                        scheduleOnRN(onDrop, project.id, index, index),
                    ),
                );
                return;
            }
            // Glide into the gap the other chips opened before the new order takes over the layout.
            const left = landing > index ? target.x + target.width - slot.width : target.x;
            translation.set(
                withTiming(
                    left - slot.x - (scrollOffset.get() - scrollStart.get()),
                    { duration: SETTLE_MS },
                    () => scheduleOnRN(onDrop, project.id, index, landing),
                ),
            );
        },
    });
    const animatedStyle = useAnimatedStyle(() => {
        if (from.get() < 0 || dragOrder.get() !== order)
            return { transform: [{ translateX: 0 }, { scale: 1 }], zIndex: 0 };
        if (from.get() === index)
            return {
                transform: [
                    {
                        translateX: translation.get() + scrollOffset.get() - scrollStart.get(),
                    },
                    { scale: 1.06 },
                ],
                zIndex: 1,
            };
        const held = slots.get().at(from.get());
        return {
            transform: [
                {
                    translateX: withTiming(
                        projectChipShift(
                            index,
                            from.get(),
                            to.get(),
                            (held?.width ?? 0) + CHIP_GAP,
                        ),
                        { duration: SETTLE_MS },
                    ),
                },
                { scale: 1 },
            ],
            zIndex: 0,
        };
    });
    return (
        // The chip measures its place outside the GestureDetector: Gesture Handler 3 renders the detector as a native
        // node of its own (`display: contents`), and a layout measured inside it read x = 0 for every chip on Android.
        // The auto-scroll then took every held chip for one at the strip's left edge and scrolled back to the start.
        <Animated.View onLayout={(event) => onLayout(index, event)} style={animatedStyle}>
            <GestureDetector gesture={pan}>
                <Chip
                    accessibilityActions={onMove ? moveActions : undefined}
                    accessibilityHint={reorderHint}
                    accessibilityLabel={project.title}
                    label={project.title}
                    onAccessibilityAction={(event) => {
                        const target = projectMoveTarget(event.nativeEvent.actionName, index);
                        if (target !== null) onMove?.(project.id, target);
                    }}
                    onPress={() => onChoose(project.id)}
                    selected={selected}
                    selectionFill={(selectedContent) => (
                        <ChipSelectionFill
                            allSlot={allSlot}
                            page={index + 1}
                            pageProgress={pageProgress}
                            selectedContent={selectedContent}
                            slots={slots}
                            theme={theme}
                        />
                    )}
                    testID={`project-filter-${project.id}`}
                    theme={theme}
                />
            </GestureDetector>
        </Animated.View>
    );
};

/**
 * One chip's share of the Project filters' highlight. The highlight is a single pill in strip coordinates; each chip
 * draws it relative to its own place and clips it to its pill, so while a swipe carries the highlight from one chip to
 * the next it leaves the first and enters the second. Inside it the chip's label is drawn again in the selected colors,
 * held still against the chip, so the label changes color exactly where the highlight covers it. Drawing it inside the
 * chip also lets it move with a chip that is being dragged to a new place.
 */
const ChipSelectionFill = ({
    allSlot,
    page,
    pageProgress,
    selectedContent,
    slots,
    theme,
}: {
    /**
     * The chip's content in the selected colors, laid out from the chip's left edge.
     */
    selectedContent: ReactNode;
    allSlot: SharedValue<ProjectChipSlot | undefined>;
    /**
     * This chip's page: 0 for All, then each Project.
     */
    page: number;
    pageProgress: SharedValue<number>;
    /**
     * The Project chips' places, without All.
     */
    slots: SharedValue<ProjectChipSlot[]>;
    theme: MobileTheme;
}) => {
    const fill = useDerivedValue(() => {
        const pageSlots = [allSlot.get(), ...slots.get()];
        const own = pageSlots[page];
        const highlight = projectChipIndicator(pageProgress.get(), pageSlots);
        // Before the strip is measured, the chip at the current page fills itself so the first frame shows the selection.
        // The width only has to cover the pill, which clips it; a number keeps the animated `width` one type.
        if (!own || !highlight)
            return {
                left: 0,
                opacity: Math.round(pageProgress.get()) === page ? 1 : 0,
                width: UNMEASURED_FILL_WIDTH,
            };
        return { left: highlight.x - own.x, opacity: 1, width: highlight.width };
    });
    const fillStyle = useAnimatedStyle(() => fill.get());
    // Cancels the fill's offset, so the recolored label stays exactly over the chip's own label.
    const contentStyle = useAnimatedStyle(() => ({ left: -fill.get().left }));
    return (
        <Animated.View
            pointerEvents="none"
            style={[styles.selectionFill, { backgroundColor: theme.primary }, fillStyle]}
        >
            <Animated.View style={[styles.selectionContent, contentStyle]}>
                {selectedContent}
            </Animated.View>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    chips: {
        gap: CHIP_GAP,
        paddingHorizontal: mobileSpace.lg,
        paddingVertical: mobileSpace.xs,
    },
    // The strip has a row of its own under the header, so it takes the chips' height rather than growing to fill.
    scroll: { flexGrow: 0 },
    selectionContent: { position: 'absolute', top: 0 },
    selectionFill: {
        borderRadius: mobileRadius.pill,
        bottom: 0,
        overflow: 'hidden',
        position: 'absolute',
        top: 0,
    },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
