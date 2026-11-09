/**
 * Always-on, in-memory record of where the pointer went near the window's title-bar row and which presses reached the
 * page, published read-only on `globalThis.__caxriPointerTrace` for a CDP session.
 *
 * It exists for a failure that leaves no other evidence: a press on a tab or a Secondary Side Bar tab that never
 * reaches the page (a stale window drag region or the macOS full-screen title bar takes it) looks exactly like a press
 * the page ignored, and it recovers after a Session switch or a restart. Reading this trace after the user reports it
 * tells the two apart: moves recorded over the target with no `pointerdown` there mean the press stopped above the
 * page. Entries hold coordinates, event kinds, and the target's first class token only; never text or values.
 */

/**
 * Height of the band moves are kept for: the title-bar row (36px) plus a margin, so a move sampled just below it still
 * shows the pointer approaching. Presses are kept everywhere.
 */
export const POINTER_TRACE_BAND_HEIGHT = 48;

/**
 * Minimum gap between two kept moves. Enough to show the pointer's path to a target without one entry per frame.
 */
export const POINTER_TRACE_MOVE_INTERVAL_MS = 150;

/**
 * Ring capacity. A few minutes of activity near the top of the window, so a report made shortly after the failure still
 * finds it.
 */
export const POINTER_TRACE_CAPACITY = 600;

type PointerTraceEntry =
    | { kind: 'move'; t: number; x: number; y: number }
    | {
          kind: 'pointerdown' | 'pointerup' | 'click';
          t: number;
          x: number;
          y: number;
          /**
           * First class token, or the tag name when the element has no class.
           */
          target: string | null;
      }
    | { kind: 'focus' | 'blur'; t: number }
    | { kind: 'shown'; t: number; surface: string };

export interface PointerTrace {
    move(x: number, y: number): void;
    press(
        kind: 'pointerdown' | 'pointerup' | 'click',
        x: number,
        y: number,
        target: string | null,
    ): void;
    window(kind: 'focus' | 'blur'): void;
    /**
     * A kept-alive surface (a Session's Workbench, the Settings page) became the visible one.
     */
    shown(surface: string): void;
    entries(): PointerTraceEntry[];
}

export function createPointerTrace(now: () => number = Date.now): PointerTrace {
    const ring: PointerTraceEntry[] = [];
    let lastMoveAt = -Infinity;
    const push = (entry: PointerTraceEntry) => {
        ring.push(entry);
        if (ring.length > POINTER_TRACE_CAPACITY) ring.shift();
    };
    return {
        move(x, y) {
            if (y > POINTER_TRACE_BAND_HEIGHT) return;
            const t = now();
            if (t - lastMoveAt < POINTER_TRACE_MOVE_INTERVAL_MS) return;
            lastMoveAt = t;
            push({ kind: 'move', t, x: Math.round(x), y: Math.round(y) });
        },
        press(kind, x, y, target) {
            push({ kind, t: now(), x: Math.round(x), y: Math.round(y), target });
        },
        window(kind) {
            push({ kind, t: now() });
        },
        shown(surface) {
            push({ kind: 'shown', t: now(), surface });
        },
        entries: () => [...ring],
    };
}

function targetToken(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    const token = target.classList.item(0);
    return token ?? target.tagName.toLowerCase();
}

/**
 * Elements whose own `app-region` differs from their parent's, that is, where a drag or no-drag region starts. Computed
 * on demand only: walking every element is far too costly to run per event.
 */
function readAppRegions() {
    return [...document.querySelectorAll('*')].flatMap((element) => {
        const region = getComputedStyle(element).getPropertyValue('app-region');
        if (region !== 'drag' && region !== 'no-drag') return [];
        const parent = element.parentElement;
        if (parent && getComputedStyle(parent).getPropertyValue('app-region') === region) return [];
        const rect = element.getBoundingClientRect();
        if (region === 'no-drag' && rect.top > POINTER_TRACE_BAND_HEIGHT) return [];
        return [
            {
                region,
                target: targetToken(element),
                rect: [rect.x, rect.y, rect.width, rect.height].map(Math.round),
                hidden: element.closest('[hidden]') !== null,
            },
        ];
    });
}

interface PointerTraceInspector {
    entries(): PointerTraceEntry[];
    appRegions(): ReturnType<typeof readAppRegions>;
}

declare global {
    // eslint-disable-next-line vars-on-top -- `declare global { var … }` is the required ambient form
    var __caxriPointerTrace: PointerTraceInspector;
}

/**
 * Starts recording and publishes the inspector. Capture-phase listeners, so a handler that stops propagation cannot
 * hide a press that did reach the page.
 */
export function installPointerTrace(): void {
    const trace = createPointerTrace();
    const options = { capture: true, passive: true } as const;
    document.addEventListener(
        'pointermove',
        (event) => trace.move(event.clientX, event.clientY),
        options,
    );
    for (const kind of ['pointerdown', 'pointerup', 'click'] as const) {
        document.addEventListener(
            kind,
            (event) => trace.press(kind, event.clientX, event.clientY, targetToken(event.target)),
            options,
        );
    }
    addEventListener('focus', () => trace.window('focus'));
    addEventListener('blur', () => trace.window('blur'));
    // Kept-alive surfaces switch by toggling `hidden`; recording which one became visible places a lost press relative
    // to the Session switch or Settings close that the user reports as making it recover.
    new MutationObserver((records) => {
        for (const record of records) {
            const element = record.target;
            if (!(element instanceof HTMLElement) || element.hidden) continue;
            if (element.classList.contains('settings-page-host')) trace.shown('settings');
            else if (element.classList.contains('workbench-session')) {
                trace.shown(
                    `session:${element.dataset.workbenchSessionId?.slice(0, 8) ?? 'unknown'}`,
                );
            }
        }
    }).observe(document.body, { attributeFilter: ['hidden'], attributes: true, subtree: true });
    Object.defineProperty(globalThis, '__caxriPointerTrace', {
        configurable: true,
        value: {
            entries: () => trace.entries(),
            appRegions: readAppRegions,
        } satisfies PointerTraceInspector,
    });
}
