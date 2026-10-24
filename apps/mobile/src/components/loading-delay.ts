/**
 * How long a delayed loading indicator waits before it draws. A folder listing or a file read over a nearby connection
 * settles well inside this window, and a spinner that appears and vanishes a moment later reads as a flicker rather
 * than as progress. The same 500ms as Desktop's `LOADING_SKELETON_DELAY_MS` and `spin-delay`'s default
 * (https://github.com/smeijer/spin-delay).
 */
export const LOADING_REVEAL_DELAY_MS = 500;
