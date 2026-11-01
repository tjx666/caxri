import { useRef, useState } from 'react';

import { Button } from '../../../components/ui/button';
import { Checkbox } from '../../../components/ui/checkbox';
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
    const [shouldApplyToAll, setShouldApplyToAll] = useState(false);
    const resolve = (choice: Parameters<typeof resolveFileConflictChoice>[0]) => {
        // Cancel only ever answers the current entry; "Apply to all" must not silently cancel the rest of the batch.
        resolveFileConflictChoice(choice, choice !== 'cancel' && shouldApplyToAll);
        setShouldApplyToAll(false);
    };

    return (
        <Dialog
            open={isOpen}
            onOpenChange={(nextOpen) => {
                if (!nextOpen) resolve('cancel');
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
                    <div className="flex items-center justify-end gap-2 p-4">
                        {(request.remaining ?? 0) > 0 && (
                            <label className="mr-auto flex cursor-pointer items-center gap-2 text-[12px] text-muted">
                                <Checkbox
                                    checked={shouldApplyToAll}
                                    onCheckedChange={(next) => setShouldApplyToAll(next === true)}
                                />
                                {t('viewContainers.files.conflict.applyToAll')}
                            </label>
                        )}
                        <Button variant="secondary" onClick={() => resolve('keep-both')}>
                            {t('viewContainers.files.conflict.keepBoth')}
                        </Button>
                        <Button
                            data-conflict-cancel
                            variant="secondary"
                            onClick={() => resolve('cancel')}
                        >
                            {t('common.cancel')}
                        </Button>
                        {!request.folderGated && (
                            <Button onClick={() => resolve('replace')}>
                                {t('viewContainers.files.conflict.replace')}
                            </Button>
                        )}
                    </div>
                </DialogContent>
            )}
        </Dialog>
    );
}
