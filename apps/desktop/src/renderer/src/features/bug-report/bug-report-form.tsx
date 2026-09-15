import { useEffect, useRef } from 'react';

import { Alert } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Field, FieldLabel } from '../../components/ui/field';
import { Textarea } from '../../components/ui/textarea';
import type { BugReportDraft } from './bug-report';
import { BugReportScreenshotField } from './bug-report-screenshot-field';

interface BugReportFormProperties {
    annotationCount: number;
    busy: boolean;
    /**
     * Whether the form holds work a discard would actually destroy; the action is hidden until it does.
     */
    canDiscardDraft: boolean;
    canPreview: boolean;
    capturing: boolean;
    contextError: string | undefined;
    draft: BugReportDraft;
    hasTargets: boolean;
    imageDeliveryNotice: string;
    onAnnotate: () => void;
    onCapture: () => void;
    onDiscardDraft: () => void;
    onPreview: () => void;
    onRemoveScreenshot: () => void;
    screenshotDataUrl: string | undefined;
    screenshotError: string | undefined;
    updateDraft: (field: keyof BugReportDraft, value: string) => void;
}

/**
 * The draft-entry step of the Bug Report dialog, shown before a report has been previewed.
 */
export function BugReportForm({
    annotationCount,
    busy,
    canDiscardDraft,
    canPreview,
    capturing,
    contextError,
    draft,
    hasTargets,
    imageDeliveryNotice,
    onAnnotate,
    onCapture,
    onDiscardDraft,
    onPreview,
    onRemoveScreenshot,
    screenshotDataUrl,
    screenshotError,
    updateDraft,
}: BugReportFormProperties) {
    const actualReference = useRef<HTMLTextAreaElement>(null);

    /**
     * Claims initial focus once the automatic capture is over, because nothing else can. The dialog mounts with
     * `visibility: hidden` so the capture never photographs the dialog itself, and a hidden subtree is unfocusable:
     * both Base UI's initial-focus pass and a plain `autoFocus` run during that window and silently do nothing, leaving
     * focus wherever it was before the dialog opened (usually the Terminal). Re-running on every transition back to
     * visible also repairs the same loss after a Retake, since hiding the dialog blurs whatever it contained. The
     * `activeElement` guard only yields to a form control the user has already focused: once the dialog becomes
     * visible, Base UI's focus manager lands focus on the popup container itself, which counts as "inside the dialog"
     * but is not a place the user can type. The `capturing` flag clears one paint before the `invisible` class is
     * actually gone from the computed style, so the focus call polls a few frames for real visibility instead of firing
     * into a still-hidden subtree.
     */
    useEffect(() => {
        if (capturing) return;
        let frame = 0;
        let remainingFrames = 30;
        const focusWhenVisible = (): void => {
            const textarea = actualReference.current;
            const dialog = textarea?.closest('[data-bug-report-dialog]');
            if (!textarea || !dialog) return;
            if (getComputedStyle(textarea).visibility === 'hidden') {
                remainingFrames -= 1;
                if (remainingFrames > 0) frame = requestAnimationFrame(focusWhenVisible);
                return;
            }
            const active = document.activeElement;
            const isUserControlFocused =
                active instanceof HTMLElement &&
                dialog.contains(active) &&
                (active instanceof HTMLTextAreaElement ||
                    active instanceof HTMLInputElement ||
                    active instanceof HTMLButtonElement ||
                    active instanceof HTMLSelectElement);
            if (!isUserControlFocused) textarea.focus();
        };
        frame = requestAnimationFrame(focusWhenVisible);
        return () => cancelAnimationFrame(frame);
    }, [capturing]);

    return (
        <div className="grid gap-3 p-4">
            {contextError && (
                <Alert variant="danger" className="text-[12px]">
                    {contextError}
                </Alert>
            )}
            {!contextError && !hasTargets && (
                <Alert variant="info" className="text-[12px]">
                    No running Agent in this Session — you can still copy the report to paste
                    manually.
                </Alert>
            )}
            <BugReportScreenshotField
                annotationCount={annotationCount}
                capturing={capturing}
                dataUrl={screenshotDataUrl}
                imageDeliveryNotice={imageDeliveryNotice}
                screenshotError={screenshotError}
                onAnnotate={onAnnotate}
                onCapture={onCapture}
                onRemove={onRemoveScreenshot}
            />
            <Field>
                <FieldLabel htmlFor="bug-report-actual">Actual behavior</FieldLabel>
                <Textarea
                    ref={actualReference}
                    id="bug-report-actual"
                    maxLength={12_000}
                    placeholder="What happened?"
                    value={draft.actual}
                    onChange={(event) => updateDraft('actual', event.target.value)}
                />
            </Field>
            <Field>
                <FieldLabel htmlFor="bug-report-expected">Expected behavior</FieldLabel>
                <Textarea
                    id="bug-report-expected"
                    maxLength={12_000}
                    placeholder="What should have happened?"
                    value={draft.expected}
                    onChange={(event) => updateDraft('expected', event.target.value)}
                />
            </Field>
            <Field>
                <FieldLabel htmlFor="bug-report-steps">Reproduction steps (optional)</FieldLabel>
                <Textarea
                    id="bug-report-steps"
                    maxLength={12_000}
                    placeholder="1. …"
                    value={draft.steps}
                    onChange={(event) => updateDraft('steps', event.target.value)}
                />
            </Field>
            <div className="flex items-center justify-end gap-2">
                {/* Closing keeps the draft, so this is the only way to throw it away; `mr-auto` keeps it clear of the primary action. */}
                {canDiscardDraft && (
                    <Button
                        className="mr-auto"
                        disabled={busy}
                        id="bug-report-discard-draft"
                        variant="ghost"
                        onClick={onDiscardDraft}
                    >
                        Discard Draft
                    </Button>
                )}
                <Button disabled={!canPreview || busy} onClick={onPreview}>
                    {busy ? 'Preparing…' : 'Preview Report'}
                </Button>
            </div>
        </div>
    );
}
