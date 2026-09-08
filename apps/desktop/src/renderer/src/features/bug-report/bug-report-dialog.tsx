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
import { ScreenshotAnnotatorDialog } from './screenshot-annotator-dialog';
import { useBugReportDialog } from './use-bug-report-dialog';

function BugReportDialogContent() {
    const {
        annotatorOpen,
        applyAnnotations,
        backToForm,
        busy,
        canPreview,
        captureHidden,
        captureScreenshot,
        capturing,
        closeAnnotator,
        contextError,
        copyReport,
        draft,
        imageDeliveryNotice,
        openAnnotator,
        preview,
        previewDataUrl,
        removeScreenshot,
        report,
        screenshot,
        screenshotError,
        selectedTargetId,
        send,
        sendError,
        sessionChanged,
        setSelectedTargetId,
        target,
        targets,
        updateDraft,
    } = useBugReportDialog();

    return (
        <>
            <DialogContent
                backdropClassName={captureHidden ? 'invisible' : undefined}
                className={cn('w-[min(680px,calc(100vw-32px))]', captureHidden && 'invisible')}
                data-bug-report-dialog
            >
                <DialogHeader>
                    <DialogTitle>Report Bug to Agent</DialogTitle>
                    <DialogDescription>
                        Capture, annotate, and send a redacted Markdown bug report to a running
                        Agent in the current Session.
                    </DialogDescription>
                </DialogHeader>
                {report ? (
                    <BugReportPreview
                        busy={busy}
                        imageDeliveryNotice={imageDeliveryNotice}
                        report={report}
                        screenshotDataUrl={previewDataUrl}
                        screenshotError={screenshotError}
                        selectedTargetId={selectedTargetId}
                        sendError={sendError}
                        sessionChanged={sessionChanged}
                        target={target}
                        targets={targets}
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
                    />
                ) : (
                    <BugReportForm
                        annotationCount={screenshot?.annotations.length ?? 0}
                        busy={busy}
                        canPreview={canPreview}
                        capturing={capturing}
                        contextError={contextError}
                        draft={draft}
                        hasTargets={targets.length > 0}
                        imageDeliveryNotice={imageDeliveryNotice}
                        screenshotDataUrl={previewDataUrl}
                        screenshotError={screenshotError}
                        updateDraft={updateDraft}
                        onAnnotate={openAnnotator}
                        onCapture={() => {
                            // eslint-disable-next-line no-void -- intentional floating-promise discard, captureScreenshot() reports its own errors
                            void captureScreenshot();
                        }}
                        onPreview={() => {
                            // eslint-disable-next-line no-void -- intentional floating-promise discard, preview() reports its own errors
                            void preview();
                        }}
                        onRemoveScreenshot={removeScreenshot}
                    />
                )}
            </DialogContent>
            {screenshot && (
                <ScreenshotAnnotatorDialog
                    annotations={screenshot.annotations}
                    height={screenshot.original.height}
                    open={annotatorOpen}
                    source={screenshot.original.dataUrl}
                    width={screenshot.original.width}
                    onCancel={closeAnnotator}
                    onDone={applyAnnotations}
                />
            )}
        </>
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
