import { Easing } from 'react-native-reanimated';

/**
 * How the Project pager settles on a page after a swipe. The Project filters' highlight reuses it for a chip tap, so
 * both motions read as the same pager, and for a swipe's release, so the highlight lands with the pages.
 */
export const PAGER_SETTLE = { duration: 240, easing: Easing.out(Easing.cubic) };
