import { FileX } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../components/ui/empty';
import { useTranslation } from '../../i18n';
import { openFileWithDefaultApp, revealFile } from '../../lib/desktop-file-actions';
import { useIsLocalOnlyAvailable } from '../../stores/environment';
import { openPreviewSource } from './preview-commands';

/**
 * A preview with nothing to draw (no previewer for the format, an empty diagram) still offers a way forward instead of
 * a dead-end sentence (DESIGN.md principle 9): the file's editable source, and for a file Caxri cannot show, the app
 * the operating system registers for it (primary, because opening the file is what the user came for) with Finder as
 * the secondary way to find it.
 *
 * Both actions take a Project file path. A caller omits `path` for a document that only exists in the Renderer cache
 * (an external or virtual tab), where neither the source tab nor Finder has a file to reach.
 */
export function PreviewEmptyState({
    title,
    path,
    showOpenWithDefaultApp = false,
    showReveal = false,
    showSource = true,
}: {
    title: string;
    path?: string;
    /**
     * Off for a file with no text form (a binary file), where the source would open straight back into this state.
     */
    showSource?: boolean;
    /**
     * Off for a format Caxri can preview but whose file is simply empty: there the source tab is the whole recovery.
     */
    showReveal?: boolean;
    /**
     * On for a file Caxri cannot show at all. Dropped in an SSH Host window, which cannot hand a file on the SSH Host
     * to an application on this Mac (the same rule as `documentLoadRecoveryAction`).
     */
    showOpenWithDefaultApp?: boolean;
}) {
    const { t } = useTranslation();
    const canOpenLocally = useIsLocalOnlyAvailable();
    const hasOpenWithDefaultApp = showOpenWithDefaultApp && canOpenLocally;
    return (
        <Empty className="empty-work h-full flex-1">
            <EmptyMedia>
                <FileX aria-hidden="true" className="text-muted" size={28} />
            </EmptyMedia>
            <EmptyTitle className="max-w-80 text-pretty">{title}</EmptyTitle>
            {path && (
                <div className="flex flex-wrap items-center justify-center gap-2">
                    {showSource && (
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => openPreviewSource(path)}
                        >
                            {t('preview.openSource')}
                        </Button>
                    )}
                    {hasOpenWithDefaultApp && (
                        <Button
                            size="sm"
                            onClick={() => {
                                // eslint-disable-next-line no-void -- the helper reports its own failure through a toast
                                void openFileWithDefaultApp(path);
                            }}
                        >
                            {t('editor.load.openWithDefaultApp')}
                        </Button>
                    )}
                    {showReveal && (
                        <Button
                            size="sm"
                            // Secondary weight only when it is the one way forward; beside a stronger action it steps back.
                            variant={showSource || hasOpenWithDefaultApp ? 'ghost' : 'secondary'}
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
