import { useEffect, useRef } from 'react';

import { Trash2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import type { ScreenshotAnnotation } from './screenshot-annotations';
import {
    ANNOTATION_BADGE_TEXT_COLOR,
    ANNOTATION_COLOR,
    ANNOTATION_NOTE_MAX_LENGTH,
} from './screenshot-annotations';

function AnnotationNoteRow({
    annotation,
    index,
    isSelected,
    onFocusHandled,
    onNoteChange,
    onRemove,
    onSelect,
    shouldFocus,
}: {
    annotation: ScreenshotAnnotation;
    index: number;
    isSelected: boolean;
    onFocusHandled: () => void;
    onNoteChange: (note: string) => void;
    onRemove: () => void;
    onSelect: () => void;
    shouldFocus: boolean;
}) {
    const { t } = useTranslation();
    const noteReference = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (!shouldFocus) return;
        noteReference.current?.focus();
        onFocusHandled();
    }, [onFocusHandled, shouldFocus]);

    return (
        <div
            className={cn(
                'grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded border p-2',
                isSelected ? 'border-accent bg-elevated' : 'border-transparent',
            )}
        >
            <span
                aria-hidden="true"
                className="grid size-6 place-items-center rounded-full text-[11px] font-semibold"
                style={{ backgroundColor: ANNOTATION_COLOR, color: ANNOTATION_BADGE_TEXT_COLOR }}
            >
                {index + 1}
            </span>
            <Textarea
                ref={noteReference}
                aria-label={t('bugReport.annotations.noteLabel', { number: index + 1 })}
                id={`bug-report-annotation-note-${index}`}
                maxLength={ANNOTATION_NOTE_MAX_LENGTH}
                placeholder={t('bugReport.annotations.notePlaceholder')}
                value={annotation.note}
                onChange={(event) => onNoteChange(event.target.value)}
                onFocus={onSelect}
            />
            <Button
                aria-label={t('bugReport.annotations.delete', { number: index + 1 })}
                size="icon"
                variant="ghost"
                onClick={onRemove}
            >
                <Trash2 aria-hidden="true" size={13} />
            </Button>
        </div>
    );
}

interface ScreenshotAnnotationListProperties {
    annotations: readonly ScreenshotAnnotation[];
    focusAnnotationId: string | undefined;
    onFocusHandled: () => void;
    onNoteChange: (id: string, note: string) => void;
    onRemove: (id: string) => void;
    onSelect: (id: string) => void;
    selectedId: string | undefined;
}

/**
 * The note column beside the annotated screenshot. The numbers here are the badge numbers drawn on the image, which is
 * the whole point of the surface: the Agent receives one image plus one numbered note per marked area.
 */
export function ScreenshotAnnotationList({
    annotations,
    focusAnnotationId,
    onFocusHandled,
    onNoteChange,
    onRemove,
    onSelect,
    selectedId,
}: ScreenshotAnnotationListProperties) {
    const { t } = useTranslation();
    return (
        <div className="grid content-start gap-2">
            <div className="grid gap-1">
                <h3 className="m-0 text-[13px] font-semibold">
                    {t('bugReport.annotations.title')}
                </h3>
                <p className="m-0 text-[11px] leading-[1.45] text-muted">
                    {t('bugReport.annotations.description')}
                </p>
            </div>
            {annotations.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">{t('bugReport.annotations.empty')}</p>
            ) : (
                <div className="grid max-h-[70vh] gap-1 overflow-auto">
                    {annotations.map((annotation, index) => (
                        <AnnotationNoteRow
                            key={annotation.id}
                            annotation={annotation}
                            index={index}
                            isSelected={annotation.id === selectedId}
                            shouldFocus={annotation.id === focusAnnotationId}
                            onFocusHandled={onFocusHandled}
                            onNoteChange={(note) => onNoteChange(annotation.id, note)}
                            onRemove={() => onRemove(annotation.id)}
                            onSelect={() => onSelect(annotation.id)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
