/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import type { SharedValue } from 'react-native-reanimated';
import Animated, {
    scrollTo,
    useAnimatedRef,
    useAnimatedStyle,
    useFrameCallback,
    useScrollOffset,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { Chip } from '../../../components/chip';
import { useTranslation } from '../../../i18n';
import { mobileSpace } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import type { ProjectChipSlot } from '../project-order';
import { projectAutoScrollStep, projectChipShift, projectDropIndex } from '../project-order';

/**
 * Holding a chip this long picks it up; a shorter touch stays a tap, and moving first scrolls the strip.
 */
const PICK_UP_DELAY_MS = 300;
/**
 * A held chip within this distance of either end of the strip scrolls it, up to `AUTO_SCROLL_MAX_STEP` per frame.
 */
const AUTO_SCROLL_EDGE = 48;
const AUTO_SCROLL_MAX_STEP = 8;
const SETTLE_MS = 150;
const CHIP_GAP = mobileSpace.sm;

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
    projects,
    theme,
}: {
    activeProjectId: string | null;
    onChooseProject: (projectId: string | null) => void;
    /**
     * Present only for a control device; without it the chips only filter.
     */
    onMoveProject?: (projectId: string, toIndex: number) => void;
    projects: ProjectFilterChoice[];
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
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
    // or the strip would flash the old order for a frame.
    useLayoutEffect(() => {
        slotsReference.current = slotsReference.current.slice(0, projects.length);
        drag.slots.set(slotsReference.current);
        drag.from.set(-1);
        drag.to.set(-1);
        drag.translation.set(0);
    }, [drag.from, drag.slots, drag.to, drag.translation, projectOrder, projects.length]);
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
            <Chip
                accessibilityLabel={t('sessions.home.allProjects')}
                label={t('sessions.home.allProjects')}
                onPress={() => onChooseProject(null)}
                selected={activeProjectId === null}
                testID="project-filter-all"
                theme={theme}
            />
            {/* react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- A Mac has a handful of Projects, and a virtualized cell would measure each chip in its own cell instead of along the strip, which the drag needs. */}
            {projects.map((project, index) => (
                <ProjectChip
                    key={project.id}
                    drag={drag}
                    index={index}
                    onChoose={onChooseProject}
                    onDragStart={() => setDragging(true)}
                    onDrop={drop}
                    onLayout={measure}
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
    drag,
    index,
    onChoose,
    onDragStart,
    onDrop,
    onLayout,
    project,
    reorderHint,
    selected,
    theme,
}: {
    drag: ChipDrag;
    index: number;
    onChoose: (projectId: string) => void;
    onDragStart: () => void;
    onDrop: (projectId: string, from: number, to: number) => void;
    onLayout: (index: number, event: LayoutChangeEvent) => void;
    project: ProjectFilterChoice;
    /**
     * Present only when the chip can be dragged.
     */
    reorderHint?: string;
    selected: boolean;
    theme: MobileTheme;
}) => {
    const { from, scrollOffset, scrollStart, slots, to, translation } = drag;
    const pan = usePanGesture({
        activateAfterLongPress: PICK_UP_DELAY_MS,
        enabled: reorderHint !== undefined,
        onActivate: () => {
            from.set(index);
            to.set(index);
            translation.set(0);
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
        if (from.get() < 0) return { transform: [{ translateX: 0 }, { scale: 1 }], zIndex: 0 };
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
        <GestureDetector gesture={pan}>
            <Animated.View onLayout={(event) => onLayout(index, event)} style={animatedStyle}>
                <Chip
                    accessibilityHint={reorderHint}
                    accessibilityLabel={project.title}
                    label={project.title}
                    onPress={() => onChoose(project.id)}
                    selected={selected}
                    testID={`project-filter-${project.id}`}
                    theme={theme}
                />
            </Animated.View>
        </GestureDetector>
    );
};

const styles = StyleSheet.create({
    chips: {
        gap: CHIP_GAP,
        paddingBottom: mobileSpace.sm,
        paddingHorizontal: mobileSpace.lg,
        paddingTop: mobileSpace.xs,
    },
    scroll: { flex: 1 },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
