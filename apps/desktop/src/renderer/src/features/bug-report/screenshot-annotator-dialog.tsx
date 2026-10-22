import { useState } from 'react';

import { errorMessage } from '@caxri/protocol';
import { MoveUpRight, Square } from 'lucide-react';

import { Alert } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { useTranslation } from '../../i18n';
import { ScreenshotAnnotationCanvas } from './screenshot-annotation-canvas';
import { ScreenshotAnnotationList } from './screenshot-annotation-list';
import type { ScreenshotAnnotation, ScreenshotAnnotationKind } from './screenshot-annotations';
import { MAX_ANNOTATIONS } from './screenshot-annotations';
import { useScreenshotAnnotator } from './use-screenshot-annotator';

interface ScreenshotAnnotatorDialogProperties {
    annotations: readonly ScreenshotAnnotation[];
    height: number;
    onCancel: () => void;
    onDone: (annotations: ScreenshotAnnotation[], annotatedDataUrl: string | undefined) => void;
    open: boolean;
    /**
     * The original, unannotated capture; every edit re-rasterizes from it.
     */
    source: string;
    width: number;
}

function ScreenshotAnnotatorContent({
    annotations,
    height,
    onCancel,
    onDone,
    source,
    width,
}: Omit<ScreenshotAnnotatorDialogProperties, 'open'>) {
    const { t } = useTranslation();
    const annotator = useScreenshotAnnotator(annotations);
    const [busy, setBusy] = useState(false);
    const [renderError, setRenderError] = useState<string>();

    const finish = async (): Promise<void> => {
        setBusy(true);
        try {
            onDone(annotator.annotations, await annotator.rasterize(source));
        } catch (error) {
            // Staying open with the marks intact beats silently handing back an unannotated image.
            setRenderError(errorMessage(error, t('bugReport.annotator.renderFailed')));
        }
        // After the try/catch rather than in a `finally`, which React Compiler cannot lower; the catch never rethrows.
        setBusy(false);
    };

    return (
        <DialogContent className="w-[min(1400px,calc(100vw-32px))]" data-bug-report-annotator>
            <DialogHeader>
                <DialogTitle>{t('bugReport.annotator.title')}</DialogTitle>
                <DialogDescription>{t('bugReport.annotator.description')}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 p-4">
                <div className="flex items-center gap-3">
                    <ToggleGroup
                        aria-label={t('bugReport.annotator.tool')}
                        value={[annotator.tool]}
                        onValueChange={(next: ScreenshotAnnotationKind[]) => {
                            // Base UI reports re-activating the pressed segment as an empty selection; a drawing tool
                            // must always stay selected instead of leaving the surface inert.
                            if (next.length > 0) annotator.setTool(next[0]);
                        }}
                    >
                        <ToggleGroupItem id="bug-report-tool-box" size="dense" value="box">
                            <Square aria-hidden="true" size={13} />
                            {t('bugReport.annotator.box')}
                        </ToggleGroupItem>
                        <ToggleGroupItem id="bug-report-tool-arrow" size="dense" value="arrow">
                            <MoveUpRight aria-hidden="true" size={13} />
                            {t('bugReport.annotator.arrow')}
                        </ToggleGroupItem>
                    </ToggleGroup>
                    <p className="m-0 text-[11px] text-muted">
                        {annotator.isAtLimit
                            ? t('bugReport.annotator.limit', { max: MAX_ANNOTATIONS })
                            : t('bugReport.annotator.hint')}
                    </p>
                </div>
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                    <div className="grid place-items-center overflow-auto rounded bg-background p-2">
                        <ScreenshotAnnotationCanvas
                            annotations={annotator.annotations}
                            height={height}
                            scale={annotator.displayScale}
                            selectedId={annotator.selectedId}
                            source={source}
                            tool={annotator.tool}
                            width={width}
                            onCreate={annotator.addAnnotation}
                            onDisplayScaleChange={annotator.setDisplayScale}
                            onRemove={annotator.removeAnnotation}
                            onRemoveSelected={annotator.removeSelectedAnnotation}
                            onSelect={annotator.selectAnnotation}
                        />
                    </div>
                    <ScreenshotAnnotationList
                        annotations={annotator.annotations}
                        focusAnnotationId={annotator.focusAnnotationId}
                        selectedId={annotator.selectedId}
                        onFocusHandled={annotator.clearFocusRequest}
                        onNoteChange={annotator.updateNote}
                        onRemove={annotator.removeAnnotation}
                        onSelect={annotator.selectAnnotation}
                    />
                </div>
                {renderError && (
                    <Alert variant="danger" className="text-[12px]">
                        {renderError}
                    </Alert>
                )}
                <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={onCancel}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        disabled={busy}
                        id="bug-report-annotator-done"
                        onClick={() => {
                            // eslint-disable-next-line no-void -- intentional floating-promise discard, finish() reports its own errors
                            void finish();
                        }}
                    >
                        {t(busy ? 'bugReport.annotator.rendering' : 'common.done')}
                    </Button>
                </div>
            </div>
        </DialogContent>
    );
}

/**
 * Full-size editor stacked on top of the Bug Report dialog. Mounting the content only while open resets the editing
 * state per opening, so Cancel really discards: the committed annotations only ever come back in through `onDone`.
 */
export function ScreenshotAnnotatorDialog({
    annotations,
    height,
    onCancel,
    onDone,
    open,
    source,
    width,
}: ScreenshotAnnotatorDialogProperties) {
    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) onCancel();
            }}
        >
            {open && (
                <ScreenshotAnnotatorContent
                    annotations={annotations}
                    height={height}
                    source={source}
                    width={width}
                    onCancel={onCancel}
                    onDone={onDone}
                />
            )}
        </Dialog>
    );
}
