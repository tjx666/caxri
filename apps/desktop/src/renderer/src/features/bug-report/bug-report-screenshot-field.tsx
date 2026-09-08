import { Camera } from 'lucide-react';

import { Alert } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { FieldTitle } from '../../components/ui/field';

/**
 * Shared by the thumbnail, the annotator, and the preview so a copy edit cannot make one of them stop admitting that
 * the image is the unredacted half of the report.
 */
export const BUG_REPORT_SCREENSHOT_ALT =
    'Unredacted screenshot of the current Caxri window, including any open files and terminal output';

interface BugReportScreenshotFieldProperties {
    annotationCount: number;
    capturing: boolean;
    dataUrl: string | undefined;
    imageDeliveryNotice: string;
    onAnnotate: () => void;
    onCapture: () => void;
    onRemove: () => void;
    screenshotError: string | undefined;
}

/**
 * The screenshot row of the draft form. The capture already happened when the dialog opened, so this is a review
 * surface, not an opt-in: the thumbnail is the shortest path into the annotation editor, and Retake/Remove exist for
 * the two cases where the automatic capture caught the wrong moment or nothing worth sending.
 */
export function BugReportScreenshotField({
    annotationCount,
    capturing,
    dataUrl,
    imageDeliveryNotice,
    onAnnotate,
    onCapture,
    onRemove,
    screenshotError,
}: BugReportScreenshotFieldProperties) {
    return (
        <div className="grid gap-2">
            <FieldTitle>Screenshot</FieldTitle>
            {dataUrl ? (
                <>
                    <button
                        type="button"
                        aria-label="Annotate the captured screenshot"
                        className="relative block w-full cursor-pointer overflow-hidden rounded border border-border bg-background p-0"
                        id="bug-report-screenshot-thumbnail"
                        onClick={onAnnotate}
                    >
                        {/* Full width at natural aspect: a window capture is landscape, so the previous short height cap shrank it to a narrow strip between empty bands. The cap only guards against unusually tall captures. */}
                        <img
                            alt={BUG_REPORT_SCREENSHOT_ALT}
                            className="block max-h-96 w-full object-contain"
                            src={dataUrl}
                        />
                        {annotationCount > 0 && (
                            <span className="absolute top-2 right-2 rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-accent-foreground">
                                {annotationCount === 1
                                    ? '1 annotation'
                                    : `${annotationCount} annotations`}
                            </span>
                        )}
                    </button>
                    <div className="flex gap-2">
                        <Button
                            id="bug-report-annotate"
                            size="sm"
                            variant="secondary"
                            onClick={onAnnotate}
                        >
                            Annotate
                        </Button>
                        <Button
                            disabled={capturing}
                            id="bug-report-retake"
                            size="sm"
                            variant="secondary"
                            onClick={onCapture}
                        >
                            {capturing ? 'Capturing…' : 'Retake'}
                        </Button>
                        <Button
                            id="bug-report-remove-screenshot"
                            size="sm"
                            variant="ghost"
                            onClick={onRemove}
                        >
                            Remove
                        </Button>
                    </div>
                    {/**
                     * AGENTS.md requires diagnostics to exclude source contents and Terminal output; the text report honors that (see
                     * `bug-report.ts`'s doc comment), but a screenshot is captured pixel-for-pixel and cannot be redacted the same way.
                     * This warning keeps that gap explicit.
                     */}
                    <Alert variant="warning">
                        Unlike the text report, this screenshot is not redacted: it shows everything
                        on screen, including source code and Terminal output.
                    </Alert>
                    <p className="m-0 text-[11px] text-muted">{imageDeliveryNotice}</p>
                </>
            ) : (
                /**
                 * Without an image the row carries exactly one action, so a failed capture reuses the same control as a
                 * removed one rather than offering "Retry" beside an identical "Capture screenshot".
                 */
                <div className="grid gap-2">
                    {screenshotError && <Alert variant="warning">{screenshotError}</Alert>}
                    <div className="flex items-center gap-2">
                        <Button
                            disabled={capturing}
                            id="bug-report-capture"
                            size="sm"
                            variant="secondary"
                            onClick={onCapture}
                        >
                            <Camera aria-hidden="true" size={13} />
                            {capturing
                                ? 'Capturing…'
                                : screenshotError
                                  ? 'Retry capture'
                                  : 'Capture screenshot'}
                        </Button>
                        <p className="m-0 text-[11px] text-muted">
                            The report will be sent as text only.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
