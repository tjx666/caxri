import { FileX } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../components/ui/empty';
import { useTranslation } from '../../i18n';
import { revealFile } from '../../lib/desktop-file-actions';
import { openPreviewSource } from './preview-commands';

/**
 * A preview with nothing to draw (no previewer for the format, an empty diagram) still offers a way forward instead of
 * a dead-end sentence (DESIGN.md principle 9): the file's editable source, and Finder for a file Caxri cannot show.
 *
 * Both actions take a Project file path. A caller omits `path` for a document that only exists in the Renderer cache
 * (an external or virtual tab), where neither the source tab nor Finder has a file to reach.
 */
export function PreviewEmptyState({
    title,
    path,
    showReveal = false,
}: {
    title: string;
    path?: string;
    /**
     * Off for a format Caxri can preview but whose file is simply empty: there the source tab is the whole recovery.
     */
    showReveal?: boolean;
}) {
    const { t } = useTranslation();
    return (
        <Empty className="empty-work h-full flex-1">
            <EmptyMedia>
                <FileX aria-hidden="true" className="text-muted" size={28} />
            </EmptyMedia>
            <EmptyTitle className="max-w-80 text-pretty">{title}</EmptyTitle>
            {path && (
                <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => openPreviewSource(path)}>
                        {t('preview.openSource')}
                    </Button>
                    {showReveal && (
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                                // eslint-disable-next-line no-void -- revealFile reports its own failure through a toast
                                void revealFile(path);
                            }}
                        >
                            {t('preview.revealInFinder')}
                        </Button>
                    )}
                </div>
            )}
        </Empty>
    );
}
