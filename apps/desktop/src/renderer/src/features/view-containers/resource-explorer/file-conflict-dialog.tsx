import { useRef } from 'react';

import { Button } from '../../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../../components/ui/dialog';
import { useTranslation } from '../../../i18n';
import {
    resolveFileConflictChoice,
    useFileConflictDialogStore,
} from './file-conflict-dialog-store';

/**
 * Finder-style Replace/Keep Both/Cancel prompt for a move that collided with an existing name. Mounted once by
 * `ResourceExplorerView` so every move call site (drag-and-drop, drop on the panel root, cut-paste on a row, cut-paste
 * on the root) shares one dialog instance driven by `file-conflict-dialog.ts`'s module-level store instead of each
 * caller owning local dialog state.
 */
export function FileConflictDialog() {
    const { t } = useTranslation();
    const request = useFileConflictDialogStore((state) => state.request);
    const contentReference = useRef<HTMLDivElement>(null);
    const isOpen = Boolean(request);

    return (
        <Dialog
            open={isOpen}
            onOpenChange={(nextOpen) => {
                if (!nextOpen) resolveFileConflictChoice('cancel');
            }}
        >
            {request && (
                <DialogContent
                    ref={contentReference}
                    className="file-conflict-dialog"
                    // Cancel is the safe default action, so it (not Base UI's default first
                    // tabbable element (Keep Both)) receives initial focus.
                    initialFocus={() =>
                        contentReference.current?.querySelector<HTMLButtonElement>(
                            '[data-conflict-cancel]',
                        ) ?? null
                    }
                >
                    <DialogHeader>
                        <DialogTitle>
                            {t('viewContainers.files.conflict.title', { name: request.name })}
                        </DialogTitle>
                        <DialogDescription>
                            {t(
                                request.folderGated
                                    ? 'viewContainers.files.conflict.folderDescription'
                                    : 'viewContainers.files.conflict.fileDescription',
                                { name: request.name },
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2 p-4">
                        <Button
                            variant="secondary"
                            onClick={() => resolveFileConflictChoice('keep-both')}
                        >
                            {t('viewContainers.files.conflict.keepBoth')}
                        </Button>
                        <Button
                            data-conflict-cancel
                            variant="secondary"
                            onClick={() => resolveFileConflictChoice('cancel')}
                        >
                            {t('common.cancel')}
                        </Button>
                        {!request.folderGated && (
                            <Button
                                variant="danger"
                                onClick={() => resolveFileConflictChoice('replace')}
                            >
                                {t('viewContainers.files.conflict.replace')}
                            </Button>
                        )}
                    </div>
                </DialogContent>
            )}
        </Dialog>
    );
}
