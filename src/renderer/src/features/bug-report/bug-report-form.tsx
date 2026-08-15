import { Button } from '../../components/ui/button';
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
                <p className="m-0 rounded border border-danger px-3 py-2 text-[12px] text-danger">
                    {contextError}
                </p>
            )}
            {!contextError && !hasTargets && (
                <p className="m-0 rounded border border-border bg-elevated px-3 py-2 text-[12px] text-muted">
                    No running Agent in this Session — you can still copy the report to paste
                    manually.
                </p>
            )}
            <label className="grid gap-1 text-[12px]">
                <span>Actual behavior</span>
                <Textarea
                    autoFocus
                    maxLength={12_000}
                    placeholder="What happened?"
                    value={draft.actual}
                    onChange={(event) => updateDraft('actual', event.target.value)}
                />
            </label>
            <label className="grid gap-1 text-[12px]">
                <span>Expected behavior</span>
                <Textarea
                    maxLength={12_000}
                    placeholder="What should have happened?"
                    value={draft.expected}
                    onChange={(event) => updateDraft('expected', event.target.value)}
                />
            </label>
            <label className="grid gap-1 text-[12px]">
                <span>Reproduction steps</span>
                <Textarea
                    maxLength={12_000}
                    placeholder="1. …"
                    value={draft.steps}
                    onChange={(event) => updateDraft('steps', event.target.value)}
                />
            </label>
            <div className="grid gap-1 text-muted">
                <label className="flex items-center gap-2 text-[12px]">
                    <input
                        checked={includeScreenshot}
                        className="size-4 accent-[var(--accent)]"
                        type="checkbox"
                        onChange={(event) => onIncludeScreenshotChange(event.target.checked)}
                    />
                    Capture a screenshot of the current Caxri window, including any open files and
                    terminal output visible on screen
                </label>
                {includeScreenshot && (
                    /**
                     * AGENTS.md requires diagnostics to exclude source contents and Terminal output; the text report
                     * above honors that (see `bug-report.ts`'s doc comment), but a screenshot is captured
                     * pixel-for-pixel and cannot be redacted the same way. This warning makes that gap explicit instead
                     * of leaving it as a silently unexplained full-window capture.
                     */
                    <p className="m-0 pl-6 text-[11px] text-warning">
                        Unlike the text report, this screenshot is not redacted: it shows everything
                        on screen exactly as it appears, including source code and Terminal output.
                    </p>
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
