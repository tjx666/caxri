/**
 * The shadcn overlay layer of the motion stack (DESIGN.md "Motion"), shared by every Base UI popup so menus, selects,
 * popovers, tooltips, hover cards, and dialogs can never drift into different timings or curves.
 *
 * Why these exact classes:
 *
 * - `data-open`/`data-closed` (not the one-frame `data-starting-style`/`data-ending-style`) persist for the whole
 *   enter/exit run, so keyframe-based `animate-in`/`animate-out` run to completion. Base UI keeps the popup mounted
 *   until `getAnimations()` reports nothing running.
 * - The keyframes are gated behind `motion-safe:` because a bare `motion-reduce:animate-none` (0,1,0) loses the
 *   specificity fight against `data-open:animate-in`'s attribute selector (0,2,0). Under reduced motion no animation
 *   runs, so close unmounts without waiting a frame.
 * - Anchored popups travel 4px away from their trigger (`data-side` is set by the Positioner) on top of the 95% zoom from
 *   `--transform-origin`, so a menu reads as coming out of the button that opened it rather than appearing in place.
 *   The exit only fades and shrinks: a leaving popup has no direction to explain.
 * - `data-instant` marks Base UI's instant phase: moving between adjacent tooltips, switching between open menubar menus,
 *   a trigger opened from the keyboard, and an Escape or focus-out dismissal. Replaying the enter keyframe for every
 *   neighbor makes a toolbar sweep flicker, and a keyboard user is better served by an immediate response, so that
 *   phase shows and hides without animation. `!` is required: a plain `data-instant:` utility ties on specificity with
 *   `data-open:animate-in` and would lose on source order.
 */
const OVERLAY_TIMING =
    'duration-(--motion-overlay-enter) ease-(--motion-ease-enter) data-closed:duration-(--motion-overlay-exit) data-closed:ease-(--motion-ease-exit)';

const SIDE_TRAVEL =
    'data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=inline-start]:slide-in-from-right-1 data-[side=inline-end]:slide-in-from-left-1';

/**
 * Menus, selects, popovers, and hover cards: fade, 95% zoom from the anchor edge, and 4px travel from the trigger.
 */
export const ANCHORED_POPUP_MOTION = [
    'origin-(--transform-origin)',
    'motion-safe:data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95',
    'motion-safe:data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
    SIDE_TRAVEL,
    OVERLAY_TIMING,
    'data-instant:animate-none!',
].join(' ');

/**
 * Tooltips: fade and 2px travel only. A zoom on a single line of small text blurs the glyphs for the length of the
 * animation, and a tooltip is read, not manipulated, so it should settle without visibly growing.
 */
export const TOOLTIP_MOTION = [
    'motion-safe:data-open:animate-in data-open:fade-in-0',
    'motion-safe:data-closed:animate-out data-closed:fade-out-0',
    'data-[side=bottom]:slide-in-from-top-[2px] data-[side=top]:slide-in-from-bottom-[2px] data-[side=left]:slide-in-from-right-[2px] data-[side=right]:slide-in-from-left-[2px]',
    OVERLAY_TIMING,
    'data-instant:animate-none!',
].join(' ');

/**
 * Centered dialogs: fade plus 95% zoom from the center. No travel; a modal has no trigger edge to come from.
 */
export const DIALOG_POPUP_MOTION = [
    'motion-safe:data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95',
    'motion-safe:data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
    OVERLAY_TIMING,
].join(' ');

/**
 * Dialog backdrops: fade only, so the page behind dims rather than moves.
 */
export const DIALOG_BACKDROP_MOTION = [
    'motion-safe:data-open:animate-in data-open:fade-in-0',
    'motion-safe:data-closed:animate-out data-closed:fade-out-0',
    OVERLAY_TIMING,
].join(' ');
