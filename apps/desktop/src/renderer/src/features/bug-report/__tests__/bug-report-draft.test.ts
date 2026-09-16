import { beforeEach, describe, expect, it } from 'vitest';

import type { BugReportDraftContent, BugReportScreenshot } from '../bug-report-draft';
import {
    bugReportDraftReducer,
    clearBugReportDraft,
    EMPTY_BUG_REPORT_DRAFT,
    emptyBugReportDraftState,
    hasBugReportDraftInput,
    openBugReportDraft,
    retainBugReportDraft,
} from '../bug-report-draft';

function capture(annotationCount = 0, isRetaken = false): BugReportScreenshot {
    return {
        annotatedDataUrl: annotationCount > 0 ? 'data:image/jpeg;base64,annotated' : undefined,
        annotations: Array.from({ length: annotationCount }, (_, index) => ({
            id: `annotation-${index + 1}`,
            kind: 'box' as const,
            note: 'Broken here',
            x1: 10,
            x2: 120,
            y1: 20,
            y2: 90,
        })),
        isRetaken,
        original: { dataUrl: 'data:image/jpeg;base64,original', height: 900, width: 1440 },
    };
}

function content(overrides: Partial<BugReportDraftContent> = {}): BugReportDraftContent {
    return { draft: EMPTY_BUG_REPORT_DRAFT, screenshot: undefined, ...overrides };
}

describe('hasBugReportDraftInput', () => {
    it('treats a blank form as nothing worth keeping', () => {
        expect(hasBugReportDraftInput(content())).toBe(false);
        expect(
            hasBugReportDraftInput(
                content({ draft: { actual: '  ', expected: '\n', steps: '\t' } }),
            ),
        ).toBe(false);
    });

    it('ignores the capture the dialog takes for the user but keeps a deliberate Retake', () => {
        const automatic = content({ screenshot: capture() });
        const retaken = content({ screenshot: capture(0, true) });
        expect(hasBugReportDraftInput(automatic)).toBe(false);
        expect(hasBugReportDraftInput(retaken)).toBe(true);
    });

    it('counts any filled text field', () => {
        expect(
            hasBugReportDraftInput(
                content({ draft: { ...EMPTY_BUG_REPORT_DRAFT, actual: 'It crashed' } }),
            ),
        ).toBe(true);
        expect(
            hasBugReportDraftInput(
                content({ draft: { ...EMPTY_BUG_REPORT_DRAFT, expected: 'It should not' } }),
            ),
        ).toBe(true);
        expect(
            hasBugReportDraftInput(
                content({ draft: { ...EMPTY_BUG_REPORT_DRAFT, steps: '1. Open the dialog' } }),
            ),
        ).toBe(true);
    });

    it('ignores the automatic capture until the user marks it', () => {
        const unmarked = content({ screenshot: capture() });
        const marked = content({ screenshot: capture(1) });

        expect(hasBugReportDraftInput(unmarked)).toBe(false);
        expect(hasBugReportDraftInput(marked)).toBe(true);
    });
});

describe('bugReportDraftReducer', () => {
    it('keeps text, capture, and annotations on close', () => {
        const closing = content({
            draft: { actual: 'It crashed', expected: 'It should not', steps: '' },
            screenshot: capture(2),
        });

        const retained = bugReportDraftReducer(emptyBugReportDraftState(), {
            content: closing,
            kind: 'close',
        });

        expect(retained.draft).toEqual(closing.draft);
        expect(retained.screenshot).toBe(closing.screenshot);
        expect(retained.screenshot?.annotations).toHaveLength(2);
        expect(retained.isRestored).toBe(false);
    });

    it('forgets a close that carries nothing but the automatic capture', () => {
        const retained = bugReportDraftReducer(emptyBugReportDraftState(), {
            content: content({ screenshot: capture() }),
            kind: 'close',
        });

        expect(retained).toEqual(emptyBugReportDraftState());
    });

    it('replaces an earlier retained draft with a later empty close', () => {
        const retained = bugReportDraftReducer(emptyBugReportDraftState(), {
            content: content({ draft: { ...EMPTY_BUG_REPORT_DRAFT, actual: 'It crashed' } }),
            kind: 'close',
        });

        expect(bugReportDraftReducer(retained, { content: content(), kind: 'close' })).toEqual(
            emptyBugReportDraftState(),
        );
    });

    it('flags a retained draft as restored when it is opened', () => {
        const retained = bugReportDraftReducer(emptyBugReportDraftState(), {
            content: content({ draft: { ...EMPTY_BUG_REPORT_DRAFT, actual: 'It crashed' } }),
            kind: 'close',
        });

        const opened = bugReportDraftReducer(retained, { kind: 'open' });

        expect(opened.isRestored).toBe(true);
        expect(opened.draft.actual).toBe('It crashed');
        // Reopening again must not churn identity, which would re-seed the dialog's reducer under StrictMode.
        expect(bugReportDraftReducer(opened, { kind: 'open' })).toBe(opened);
    });

    it('opens a blank slot as a fresh form', () => {
        const empty = emptyBugReportDraftState();

        expect(bugReportDraftReducer(empty, { kind: 'open' })).toBe(empty);
    });

    it('clears everything on demand', () => {
        const retained = bugReportDraftReducer(emptyBugReportDraftState(), {
            content: content({
                draft: { ...EMPTY_BUG_REPORT_DRAFT, actual: 'It crashed' },
                screenshot: capture(1),
            }),
            kind: 'close',
        });

        expect(bugReportDraftReducer(retained, { kind: 'clear' })).toEqual(
            emptyBugReportDraftState(),
        );
    });
});

describe('window-session draft', () => {
    beforeEach(() => {
        clearBugReportDraft();
    });

    it('hands a closed draft back to the next open', () => {
        const closing = content({
            draft: { actual: 'It crashed', expected: 'It should not', steps: '1. Open it' },
            screenshot: capture(3),
        });

        retainBugReportDraft(closing);
        const reopened = openBugReportDraft();

        expect(reopened.isRestored).toBe(true);
        expect(reopened.draft).toEqual(closing.draft);
        expect(reopened.screenshot?.annotations).toHaveLength(3);
        expect(reopened.screenshot?.annotatedDataUrl).toBe('data:image/jpeg;base64,annotated');
    });

    it('opens blank when nothing was ever retained', () => {
        const opened = openBugReportDraft();

        expect(opened.isRestored).toBe(false);
        expect(opened.draft).toEqual(EMPTY_BUG_REPORT_DRAFT);
        expect(opened.screenshot).toBeUndefined();
    });

    it('survives the double open React StrictMode performs in development', () => {
        retainBugReportDraft(
            content({ draft: { ...EMPTY_BUG_REPORT_DRAFT, actual: 'It crashed' } }),
        );

        expect(openBugReportDraft().draft.actual).toBe('It crashed');
        expect(openBugReportDraft().draft.actual).toBe('It crashed');
    });

    it('drops the draft once it has been submitted or discarded', () => {
        retainBugReportDraft(
            content({
                draft: { ...EMPTY_BUG_REPORT_DRAFT, actual: 'It crashed' },
                screenshot: capture(1),
            }),
        );

        clearBugReportDraft();

        expect(openBugReportDraft()).toEqual(emptyBugReportDraftState());
    });
});
