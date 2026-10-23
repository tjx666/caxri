import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { useTranslation } from '../../i18n';
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
        canDiscardDraft,
        canPreview,
        captureHidden,
        captureScreenshot,
        capturing,
        closeAnnotator,
        contextError,
        copyReport,
        discardDraft,
        draft,
        imageDeliveryNotice,
        isRestoredDraft,
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
    const { t } = useTranslation();

    return (
        <>
            <DialogContent
                backdropClassName={captureHidden ? 'invisible' : undefined}
                className={cn('w-[min(680px,calc(100vw-32px))]', captureHidden && 'invisible')}
                data-bug-report-dialog
            >
                <DialogHeader>
                    <DialogTitle>{t('bugReport.dialog.title')}</DialogTitle>
                    <DialogDescription>{t('bugReport.dialog.description')}</DialogDescription>
                    {/**
                     * Closing this dialog keeps the draft, so a reopened dialog that is already full of text has to say where that text
                     * came from. A plain line rather than an Alert: nothing is wrong, and a live region would announce a non-event every
                     * time the dialog opens.
                     */}
                    {isRestoredDraft && !report && (
                        <p className="mt-2 mb-0 text-[11px] leading-[1.45] text-muted">
                            {t('bugReport.dialog.restoredDraft')}
                        </p>
                    )}
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
                            void copyReport();
                        }}
                        onSelectedTargetChange={setSelectedTargetId}
                        onSend={() => {
                            void send();
                        }}
                    />
                ) : (
                    <BugReportForm
                        annotationCount={screenshot?.annotations.length ?? 0}
                        busy={busy}
                        canDiscardDraft={canDiscardDraft}
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
                            void captureScreenshot();
                        }}
                        onDiscardDraft={() => {
                            void discardDraft();
                        }}
                        onPreview={() => {
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
