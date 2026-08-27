import { Alert } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Field, FieldLabel } from '../../components/ui/field';
import { Textarea } from '../../components/ui/textarea';
import type { BugReportDraft } from './bug-report';

interface BugReportFormProperties {
    busy: boolean;
    canPreview: boolean;
    contextError: string | undefined;
    draft: BugReportDraft;
    hasTargets: boolean;
    imageFallbackNotice: string;
    includeScreenshot: boolean;
    onIncludeScreenshotChange: (isChecked: boolean) => void;
    onPreview: () => void;
    updateDraft: (field: keyof BugReportDraft, value: string) => void;
}

/**
 * The draft-entry step of the Bug Report dialog, shown before a report has been previewed.
 */
export function BugReportForm({
    busy,
    canPreview,
    contextError,
    draft,
    hasTargets,
    imageFallbackNotice,
    includeScreenshot,
    onIncludeScreenshotChange,
    onPreview,
    updateDraft,
}: BugReportFormProperties) {
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
            <Field>
                <FieldLabel htmlFor="bug-report-actual">Actual behavior</FieldLabel>
                <Textarea
                    id="bug-report-actual"
                    autoFocus
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
                <FieldLabel htmlFor="bug-report-steps">Reproduction steps</FieldLabel>
                <Textarea
                    id="bug-report-steps"
                    maxLength={12_000}
                    placeholder="1. …"
                    value={draft.steps}
                    onChange={(event) => updateDraft('steps', event.target.value)}
                />
            </Field>
            <div className="grid gap-1 text-muted">
                <Field orientation="horizontal" className="justify-start gap-2">
                    <Checkbox
                        id="bug-report-screenshot"
                        checked={includeScreenshot}
                        onCheckedChange={(isChecked) => onIncludeScreenshotChange(isChecked)}
                    />
                    <FieldLabel htmlFor="bug-report-screenshot" className="text-[12px] font-normal">
                        Capture a screenshot of the current Caxri window, including any open files
                        and terminal output visible on screen
                    </FieldLabel>
                </Field>
                {includeScreenshot && (
                    /**
                     * AGENTS.md requires diagnostics to exclude source contents and Terminal output; the text report
                     * above honors that (see `bug-report.ts`'s doc comment), but a screenshot is captured
                     * pixel-for-pixel and cannot be redacted the same way. This warning makes that gap explicit instead
                     * of leaving it as a silently unexplained full-window capture.
                     */
                    <Alert variant="warning" className="border-0 p-0 pl-6">
                        Unlike the text report, this screenshot is not redacted: it shows everything
                        on screen exactly as it appears, including source code and Terminal output.
                    </Alert>
                )}
                <p className="m-0 pl-6 text-[11px]">{imageFallbackNotice}</p>
            </div>
            <div className="flex justify-end gap-2">
                <Button disabled={!canPreview || busy} onClick={onPreview}>
                    {busy ? 'Preparing…' : 'Preview Report'}
                </Button>
            </div>
        </div>
    );
}
