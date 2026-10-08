import { useRef } from 'react';

import { Button } from '../../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../../components/ui/dialog';
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
                        <DialogTitle>&ldquo;{request.name}&rdquo; already exists</DialogTitle>
                        <DialogDescription>
                            {request.folderGated
                                ? `An item named "${request.name}" already exists in this folder. Folders cannot replace or be replaced — keep both to move it under a new name.`
                                : `An item named "${request.name}" already exists in this folder. Replacing it overwrites the existing file and cannot be undone.`}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2 p-4">
                        <Button
                            variant="secondary"
                            onClick={() => resolveFileConflictChoice('keep-both')}
                        >
                            Keep Both
                        </Button>
                        <Button
                            data-conflict-cancel
                            variant="secondary"
                            onClick={() => resolveFileConflictChoice('cancel')}
                        >
                            Cancel
                        </Button>
                        {!request.folderGated && (
                            <Button
                                variant="danger"
                                onClick={() => resolveFileConflictChoice('replace')}
                            >
                                Replace
                            </Button>
                        )}
                    </div>
                </DialogContent>
            )}
        </Dialog>
    );
}
