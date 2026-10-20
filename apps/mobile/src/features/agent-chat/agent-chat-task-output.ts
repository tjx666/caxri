import type { NativeScrollEvent } from 'react-native';

/**
 * How close to the end a background task's output box may sit and still count as at the bottom, so it keeps following
 * new lines: about one 18dp output line plus rounding.
 */
const FOLLOW_SLACK_DP = 24;

/**
 * Whether a scroll position shows the end of its content, within `FOLLOW_SLACK_DP`.
 */
export const isScrolledToBottom = ({
    contentOffset,
    contentSize,
    layoutMeasurement,
}: Pick<NativeScrollEvent, 'contentOffset' | 'contentSize' | 'layoutMeasurement'>): boolean =>
    contentOffset.y + layoutMeasurement.height >= contentSize.height - FOLLOW_SLACK_DP;
