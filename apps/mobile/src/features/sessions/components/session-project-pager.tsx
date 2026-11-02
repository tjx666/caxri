import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import type { SharedValue } from 'react-native-reanimated';
import Animated, {
    cancelAnimation,
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { projectPagerPosition, projectPagerTarget, projectPagerWindow } from '../project-filter';

const styles = StyleSheet.create({
    pager: { flex: 1, overflow: 'hidden' },
    page: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
});

/**
 * How far a finger must travel sideways before the pager takes the drag instead of the list scrolling. The list's own
 * vertical slop (8dp) wins any mostly vertical drag first, and a drag that moves `PAGER_FAIL_Y_DP` vertically before
 * reaching it stays a scroll.
 */
const PAGER_ACTIVATION_DP = 24;
const PAGER_FAIL_Y_DP = 16;
const PAGER_SETTLE = { duration: 240, easing: Easing.out(Easing.cubic) };

/**
 * One Project's list. The previous and next pages stay mounted off screen (translated out of view) so a swipe can bring
 * them in without redrawing, but a translated view is still in the accessibility tree: TalkBack could focus and
 * activate rows on a page the user cannot see. An inactive page is therefore hidden from assistive tech and ignores
 * touches. Paging itself is unaffected, since the drag gesture lives on the parent `GestureDetector`.
 */
const PagerPage = ({
    children,
    index,
    isActive,
    position,
    testID,
    width,
}: {
    children: ReactNode;
    index: number;
    isActive: boolean;
    position: SharedValue<number>;
    testID: string;
    width: number;
}) => {
    const style = useAnimatedStyle(() => ({
        transform: [{ translateX: index * width - position.get() }],
    }));
    return (
        <Animated.View
            accessibilityElementsHidden={!isActive}
            importantForAccessibility={isActive ? 'auto' : 'no-hide-descendants'}
            pointerEvents={isActive ? 'auto' : 'none'}
            style={[styles.page, style]}
            testID={testID}
        >
            {children}
        </Animated.View>
    );
};

/**
 * Pages through the Project filters the way a native pager does: a sideways drag moves the whole list with the finger
 * and the neighboring Project's list follows it in from the edge, then the release settles on a page. The current page
 * and its neighbors stay mounted, keyed by page, so a settled neighbor becomes current without redrawing.
 */
export const SessionProjectPager = ({
    activeIndex,
    onSettle,
    pageCount,
    pageKey,
    renderPage,
}: {
    activeIndex: number;
    /**
     * Called once a swipe has finished animating onto another page.
     */
    onSettle: (index: number) => void;
    pageCount: number;
    /**
     * A stable id per page; it keys the page and names it `session-page-<key>` for Acceptance.
     */
    pageKey: (index: number) => string;
    renderPage: (index: number) => ReactNode;
}) => {
    const [width, setWidth] = useState(0);
    const position = useSharedValue(0);
    const dragStart = useSharedValue(0);
    const activationX = useSharedValue(0);
    /**
     * A chip tap, a Project reorder, or a settled swipe moves the current page; the pager jumps there. After a swipe
     * the animation has already arrived, so this changes nothing on screen.
     */
    useEffect(() => {
        cancelAnimation(position);
        position.set(activeIndex * width);
    }, [activeIndex, position, width]);
    const pan = usePanGesture({
        activeOffsetX: [-PAGER_ACTIVATION_DP, PAGER_ACTIVATION_DP],
        failOffsetY: [-PAGER_FAIL_Y_DP, PAGER_FAIL_Y_DP],
        maxPointers: 1,
        onActivate: (event) => {
            cancelAnimation(position);
            dragStart.set(position.get());
            // Measure from where the pager took the drag, so the page does not jump by the activation distance.
            activationX.set(event.translationX);
        },
        onUpdate: (event) => {
            position.set(
                projectPagerPosition(
                    dragStart.get(),
                    event.translationX - activationX.get(),
                    pageCount,
                    width,
                ),
            );
        },
        onDeactivate: (event) => {
            const target = event.canceled
                ? activeIndex
                : projectPagerTarget(activeIndex, pageCount, event, width);
            position.set(
                withTiming(target * width, PAGER_SETTLE, (finished) => {
                    if (finished && target !== activeIndex) scheduleOnRN(onSettle, target);
                }),
            );
        },
    });
    return (
        <GestureDetector gesture={pan}>
            <View
                onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
                style={styles.pager}
            >
                {/* Until the width is known only the current page draws, at rest; neighbors would overlap it. */}
                {(width === 0 ? [activeIndex] : projectPagerWindow(activeIndex, pageCount)).map(
                    (index) => (
                        <PagerPage
                            index={index}
                            isActive={index === activeIndex}
                            key={pageKey(index)}
                            position={position}
                            testID={`session-page-${pageKey(index)}`}
                            width={width}
                        >
                            {renderPage(index)}
                        </PagerPage>
                    ),
                )}
            </View>
        </GestureDetector>
    );
};
