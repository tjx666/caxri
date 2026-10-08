import type { MethodResult } from '@caxri/protocol';

import type { BugReportDraft } from './bug-report';
import type { ScreenshotAnnotation } from './screenshot-annotations';

type CapturedScreenshot = MethodResult<'bugReport.captureScreenshot'>;

/**
 * The original capture is never overwritten: re-opening the annotator has to redraw the marks over a clean image, so
 * `annotatedDataUrl` is a derived rasterization that is thrown away and rebuilt on every edit.
 */
export interface BugReportScreenshot {
    annotatedDataUrl: string | undefined;
    annotations: ScreenshotAnnotation[];
    /**
     * True when the user pressed Retake rather than receiving the capture the dialog takes for them on open. A retake
     * is a moment they chose (an error toast that is up right now, a menu they are holding open) and re-opening the
     * dialog would photograph a workbench that has moved on, so it counts as authored work.
     */
    isRetaken: boolean;
    original: CapturedScreenshot;
}

/**
 * Everything a closed dialog owes the next open: the three text fields, the capture, and the marks drawn on it. The
 * preview, the chosen Agent, and the diagnostics are deliberately absent: they are derived from live workbench state
 * and must be recomputed, not replayed.
 */
export interface BugReportDraftContent {
    draft: BugReportDraft;
    screenshot: BugReportScreenshot | undefined;
}

export interface BugReportDraftState extends BugReportDraftContent {
    /**
     * True when the content handed to a freshly opened dialog came back from an earlier close rather than from a blank
     * start. The dialog needs the distinction twice: to state that the draft was restored, and to skip the automatic
     * capture that would otherwise overwrite the restored screenshot and its annotations.
     */
    isRestored: boolean;
}

export type BugReportDraftAction =
    { content: BugReportDraftContent; kind: 'close' } | { kind: 'clear' } | { kind: 'open' };

export const EMPTY_BUG_REPORT_DRAFT: BugReportDraft = { actual: '', expected: '', steps: '' };

export function emptyBugReportDraftState(): BugReportDraftState {
    return { draft: EMPTY_BUG_REPORT_DRAFT, isRestored: false, screenshot: undefined };
}

/**
 * Whether the content carries work the user actually authored, which is the only thing worth surviving a close.
 *
 * The screenshot alone deliberately does not count: the dialog captures the window automatically on open, so treating a
 * bare capture as a draft would make every reflex Escape leave a "restored draft" behind, and the next open would show
 * a stale picture of a workbench the user has since navigated away from. A mark drawn on that capture is authored work,
 * and so is a deliberate Retake, so both do count.
 */
export function hasBugReportDraftInput(content: BugReportDraftContent): boolean {
    const { actual, expected, steps } = content.draft;
    const screenshot = content.screenshot;
    if (screenshot && (screenshot.annotations.length > 0 || screenshot.isRetaken)) return true;
    return Boolean(actual.trim() || expected.trim() || steps.trim());
}

/**
 * The retain-on-close, restore-on-open, clear-on-submit, clear-on-discard rules of the Bug Report draft, kept pure so
 * they are unit-testable without mounting the dialog.
 */
export function bugReportDraftReducer(
    state: BugReportDraftState,
    action: BugReportDraftAction,
): BugReportDraftState {
    switch (action.kind) {
        case 'clear': {
            return emptyBugReportDraftState();
        }
        case 'close': {
            return hasBugReportDraftInput(action.content)
                ? { ...action.content, isRestored: false }
                : emptyBugReportDraftState();
        }
        case 'open': {
            const isRestored = hasBugReportDraftInput(state);
            return isRestored === state.isRestored ? state : { ...state, isRestored };
        }
    }
}

/**
 * A single retained draft with the three operations the dialog performs on it. The state lives in a closure rather than
 * in a `createStore` store because nothing renders from it: the dialog reads it once on mount and writes it once on
 * unmount, while it does hold the raw screenshot bytes, which must stay out of the `__caxriStores` snapshot a debugging
 * session can dump (AGENTS.md forbids diagnostics that carry screen contents).
 */
interface BugReportDraftSlot {
    /**
     * Drops the retained draft. The successful-submit and the explicit Discard paths both end here.
     */
    clear(): void;
    /**
     * Hands the retained draft to an opening dialog. Idempotent, so React StrictMode's double-invoked reducer
     * initializer cannot consume or mutate it.
     */
    open(): BugReportDraftState;
    /**
     * Keeps a closing dialog's content for the next open. Content with nothing authored in it clears the slot instead,
     * so a closed-and-forgotten draft never outlives the work in it.
     */
    retain(content: BugReportDraftContent): void;
}

function createBugReportDraftSlot(): BugReportDraftSlot {
    let state = emptyBugReportDraftState();
    return {
        clear: () => {
            state = bugReportDraftReducer(state, { kind: 'clear' });
        },
        open: () => {
            state = bugReportDraftReducer(state, { kind: 'open' });
            return state;
        },
        retain: (content) => {
            state = bugReportDraftReducer(state, { content, kind: 'close' });
        },
    };
}

/**
 * The current window session's draft. Memory-only on purpose: a screenshot may show whatever was on the user's screen,
 * so the draft dies with the window instead of being written to disk (issue #976 excludes cross-restart persistence).
 */
const sessionSlot = createBugReportDraftSlot();

export function openBugReportDraft(): BugReportDraftState {
    return sessionSlot.open();
}

export function retainBugReportDraft(content: BugReportDraftContent): void {
    sessionSlot.retain(content);
}

export function clearBugReportDraft(): void {
    sessionSlot.clear();
}
