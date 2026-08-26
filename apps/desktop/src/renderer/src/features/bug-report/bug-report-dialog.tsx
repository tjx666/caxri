import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { cn } from '../../lib/utilities';
import { setBugReportOpen, useDialogStore } from '../../stores/dialogs';
import { BugReportForm } from './bug-report-form';
import { BugReportPreview } from './bug-report-preview';
import { useBugReportDialog } from './use-bug-report-dialog';

function BugReportDialogContent() {
    const {
        backToForm,
        busy,
        canPreview,
        captureHidden,
        contextError,
        copyReport,
        draft,
        imageFallbackNotice,
        includeScreenshot,
        preview,
        report,
        screenshot,
        screenshotError,
        selectedTargetId,
        send,
        sendError,
        sessionChanged,
        setIncludeScreenshot,
        setSelectedTargetId,
        target,
        targets,
        updateDraft,
    } = useBugReportDialog();

    return (
        <DialogContent
            backdropClassName={captureHidden ? 'invisible' : undefined}
            className={cn('w-[min(680px,calc(100vw-32px))]', captureHidden && 'invisible')}
            data-bug-report-dialog
        >
            <DialogHeader>
                <DialogTitle>Report Bug to Agent</DialogTitle>
                <DialogDescription>
                    Preview a redacted Markdown report before sending it to one running Agent in the
                    current Session.
                </DialogDescription>
            </DialogHeader>
            {!report ? (
                <BugReportForm
                    busy={busy}
                    canPreview={canPreview}
                    contextError={contextError}
                    draft={draft}
                    hasTargets={targets.length > 0}
                    imageFallbackNotice={imageFallbackNotice}
                    includeScreenshot={includeScreenshot}
                    onIncludeScreenshotChange={setIncludeScreenshot}
                    onPreview={() => {
                        // eslint-disable-next-line no-void -- intentional floating-promise discard, preview() reports its own errors
                        void preview();
                    }}
                    updateDraft={updateDraft}
                />
            ) : (
                <BugReportPreview
                    busy={busy}
                    imageFallbackNotice={imageFallbackNotice}
                    onBack={backToForm}
                    onCopyReport={() => {
                        // eslint-disable-next-line no-void -- intentional floating-promise discard, copyReport() reports its own errors
                        void copyReport();
                    }}
                    onSelectedTargetChange={setSelectedTargetId}
                    onSend={() => {
                        // eslint-disable-next-line no-void -- intentional floating-promise discard, send() reports its own errors
                        void send();
                    }}
                    report={report}
                    screenshot={screenshot}
                    screenshotError={screenshotError}
                    selectedTargetId={selectedTargetId}
                    sendError={sendError}
                    sessionChanged={sessionChanged}
                    target={target}
                    targets={targets}
                />
            )}
        </DialogContent>
    );
}

export function BugReportDialog() {
    const isOpen = useDialogStore((state) => state.bugReportOpen);
    const requestId = useDialogStore((state) => state.bugReportRequestId);
    return (
        <Dialog open={isOpen} onOpenChange={setBugReportOpen}>
            {isOpen && <BugReportDialogContent key={requestId} />}
        </Dialog>
    );
}
