import { resolvePickerFinalFocus } from '../lib/picker-final-focus';

/**
 * A chrome surface a command can reveal, and therefore one that has to name its own keyboard entry point.
 */
export type ChromeSurfaceId = 'panel' | 'primarySidebar' | 'secondarySidebar';

/**
 * Where keyboard focus sits at the moment a toggle runs, relative to the surface being toggled.
 */
export type ChromeFocusLocation = 'inside-surface' | 'outside-surface' | 'nowhere';

/**
 * Which element the toggle hands focus to once the layout change has been committed.
 *
 * - `surface`: the revealed surface's own entry point.
 * - `origin`: the element that owned focus when the surface was revealed.
 * - `fallback`: the workbench's registered fallback, when the origin is gone or was never recorded.
 * - `unchanged`: focus belongs to whoever has it; the toggle must not move it.
 */
type ChromeFocusTarget = 'surface' | 'origin' | 'fallback' | 'unchanged';

export interface ChromeFocusHandoff {
    /**
     * Whether the element that owns focus right now becomes this surface's recorded origin.
     */
    recordsOrigin: boolean;
    target: ChromeFocusTarget;
}

/**
 * Decides where focus came from and where it goes back to. Kept free of the DOM so the rule is testable under Vitest's
 * Node environment, which is where every Renderer unit test runs.
 *
 * Hiding a surface while focus sits somewhere else entirely is the one case that must not move focus: the user pressed
 * the chord to clear screen space, not to leave the Terminal they are typing in. Yanking them back to a recorded origin
 * there would be a second, unasked-for jump.
 */
export function resolveChromeFocusHandoff({
    focusLocation,
    isOriginRestorable,
    isRevealing,
}: {
    focusLocation: ChromeFocusLocation;
    isOriginRestorable: boolean;
    isRevealing: boolean;
}): ChromeFocusHandoff {
    if (isRevealing)
        return { recordsOrigin: focusLocation === 'outside-surface', target: 'surface' };
    if (focusLocation === 'outside-surface') return { recordsOrigin: false, target: 'unchanged' };
    return { recordsOrigin: false, target: isOriginRestorable ? 'origin' : 'fallback' };
}

/**
 * Each surface's root carries a stable class already used for layout, so focus handling needs no second marker
 * attribute on `panel.tsx` / `primary-sidebar.tsx` / `secondary-sidebar.tsx`.
 */
const SURFACE_SELECTORS: Record<ChromeSurfaceId, string> = {
    panel: '.panel',
    primarySidebar: '.session-primary-sidebar',
    secondarySidebar: '.secondary-sidebar',
};

/**
 * Where the keyboard enters each surface, tried in order.
 *
 * The Panel and the Secondary Side Bar enter at their selected chrome tab: that is the surface's own roving-tabindex
 * anchor, so arrow keys move between views and Tab continues into the view's content, exactly as it would had the user
 * tabbed in. The Primary Side Bar has no chrome tabs; its tree owns the roving Tab stop instead, so focus lands on the
 * row arrow keys would move from, falling back to the tree itself while it is still empty.
 */
const SURFACE_ENTRY_SELECTORS: Record<ChromeSurfaceId, readonly string[]> = {
    panel: ['[role="tab"][aria-selected="true"]'],
    primarySidebar: ['[role="tree"] [role="treeitem"][tabindex="0"]', '[role="tree"]'],
    secondarySidebar: ['[role="tab"][aria-selected="true"]'],
};

/**
 * Last resort when a surface has no chrome tab yet (its catalog query is still pending).
 */
const FOCUSABLE_SELECTOR =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusOrigins = new Map<ChromeSurfaceId, HTMLElement>();

function readFocusLocation(surface: Element | null, active: Element | null): ChromeFocusLocation {
    if (!active || active === active.ownerDocument.body) return 'nowhere';
    return surface?.contains(active) === true ? 'inside-surface' : 'outside-surface';
}

function surfaceEntryElement(surfaceId: ChromeSurfaceId, surface: Element): HTMLElement | null {
    const entrySelectors = SURFACE_ENTRY_SELECTORS[surfaceId];
    for (const selector of entrySelectors) {
        const entry = surface.querySelector<HTMLElement>(selector);
        if (entry) return entry;
    }
    return surface.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
}

/**
 * The selected tab of the active pane on screen. Kept-alive Sessions leave their own panes mounted but hidden, each
 * still marked `active`, so visibility picks the selected Session's.
 */
function activePaneSelectedTab(): HTMLElement | null {
    for (const pane of document.querySelectorAll<HTMLElement>('.workbench-pane.active')) {
        if (!pane.checkVisibility()) continue;
        return pane.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    }
    return null;
}

function focusSurfaceEntry(surfaceId: ChromeSurfaceId): void {
    const surface = document.querySelector(SURFACE_SELECTORS[surfaceId]);
    if (surface) surfaceEntryElement(surfaceId, surface)?.focus({ preventScroll: true });
}

/**
 * Moves keyboard focus into a chrome surface that is already visible or is being revealed in the same commit.
 *
 * The move waits one frame because revealing a surface mounts it in the commit the caller's store update schedules, so
 * its entry element does not exist yet when the command returns. Callers that also toggle visibility set it first and
 * then call this; the lookup runs after React has committed either way.
 */
export function focusChromeSurface(surfaceId: ChromeSurfaceId): void {
    // DOM lib types declare `document` as always present, but this module also loads under Vitest's Node environment.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
    if (typeof document === 'undefined') return;
    const surface = document.querySelector(SURFACE_SELECTORS[surfaceId]);
    const active = document.activeElement;
    if (surface?.contains(active)) return;
    if (active instanceof HTMLElement && active !== document.body)
        focusOrigins.set(surfaceId, active);
    else focusOrigins.delete(surfaceId);
    requestAnimationFrame(() => focusSurfaceEntry(surfaceId));
}

/**
 * Keeps the keyboard inside a surface whose body is being swapped rather than hidden: the Primary Side Bar trading its
 * Project tree for the Activity queue, and back.
 *
 * Neither function above answers this case. {@link handOffChromeFocus} decides between revealing and hiding one surface,
 * and the surface here does neither: it stays put while everything inside it unmounts. {@link focusChromeSurface}
 * returns early when focus is already inside, which is the one situation that needs acting on, because the element
 * holding focus is the element about to leave. Without this the browser drops focus onto `document.body` and the next
 * Tab restarts from the top of the document: the same failure the two functions above exist to prevent.
 *
 * Focus outside the surface is deliberately left alone: someone typing in a Terminal who reveals the queue with
 * `Cmd+Shift+N` asked to see what is waiting, not to hand over their keyboard.
 *
 * Call it _before_ the store commits the swap, for the reason {@link handOffChromeFocus} documents: the live
 * `document.activeElement` is what the decision reads, and the move itself waits a frame for React's commit.
 */
export function refocusChromeSurfaceBody(surfaceId: ChromeSurfaceId): void {
    // DOM lib types declare `document` as always present, but this module also loads under Vitest's Node environment.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
    if (typeof document === 'undefined') return;
    const surface = document.querySelector(SURFACE_SELECTORS[surfaceId]);
    if (surface?.contains(document.activeElement) !== true) return;
    requestAnimationFrame(() => focusSurfaceEntry(surfaceId));
}

/**
 * Records or restores the focus origin across one reveal/hide toggle (`Cmd+J` for the Panel, `Cmd+]` for the Secondary
 * Side Bar).
 *
 * Both chords carry `allowInEditable`, so they fire while a Terminal owns the keyboard, which is where focus normally
 * rests. Toggling visibility without touching focus therefore produced a surface the keyboard could not reach and, on
 * the way back, a lost caret: revealing the Panel left focus inside the xterm that swallows Tab, and hiding it
 * unmounted the focused element so the browser dropped focus onto `document.body`, restarting the next Tab from the top
 * of the document. DESIGN.md requires every interactive element to be keyboard-reachable, so the toggle has to hand
 * focus over and hand it back.
 *
 * Call it _before_ the store commits the visibility change: the live `document.activeElement` and the surface still
 * standing in the DOM are what the decision reads, and a hidden surface has already taken its focused element down with
 * it.
 *
 * The move itself waits one frame. The surface mounts or unmounts on the React commit this store update schedules, and
 * React batches an external-store update into a microtask, so by the next animation frame the entry element exists (or
 * the hole the surface left behind does).
 */
export function handOffChromeFocus(surfaceId: ChromeSurfaceId, isRevealing: boolean): void {
    // DOM lib types declare `document` as always present, but this module also loads under Vitest's Node environment.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
    if (typeof document === 'undefined') return;
    const selector = SURFACE_SELECTORS[surfaceId];
    const active = document.activeElement;
    const origin = focusOrigins.get(surfaceId) ?? null;
    const handoff = resolveChromeFocusHandoff({
        focusLocation: readFocusLocation(document.querySelector(selector), active),
        isOriginRestorable: origin?.isConnected === true,
        isRevealing,
    });
    if (handoff.recordsOrigin && active instanceof HTMLElement) focusOrigins.set(surfaceId, active);
    else focusOrigins.delete(surfaceId);
    if (handoff.target === 'unchanged') return;
    requestAnimationFrame(() => {
        if (handoff.target === 'surface') {
            focusSurfaceEntry(surfaceId);
            return;
        }
        // Same question a closing picker asks, so it reuses the workbench's one registered answer: the recorded element
        // when it is still connected, else the active pane's Terminal. That answer is deliberately empty for an editor
        // or a virtual tab such as a Chat's Context, where a picker keeps Base UI's own restore; a hidden surface has no
        // such restore, so it lands on the active pane's selected tab instead of `document.body`.
        const target =
            resolvePickerFinalFocus(handoff.target === 'origin' ? origin : null) ||
            activePaneSelectedTab();
        if (target) target.focus({ preventScroll: true });
    });
}
