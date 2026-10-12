import { useRef } from 'react';

import { Button } from '../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { useTranslation } from '../../i18n';
import {
    confirmationLabels,
    resolveConfirm,
    useConfirmationStore,
} from '../../stores/confirmations';

/**
 * The application's single confirmation modal, mounted once by `App` and driven by `stores/confirmations.ts` so every
 * `caxri.window.showConfirm(...)` caller shares one appearance, one keyboard contract, and one dismissal meaning
 * instead of hand-rolling another Dialog per feature.
 */
export function ConfirmationDialog() {
    const { t } = useTranslation();
    const request = useConfirmationStore((state) => state.request);
    const contentReference = useRef<HTMLDivElement>(null);
    const labels = request ? confirmationLabels(request, t) : undefined;

    return (
        <Dialog
            open={Boolean(request)}
            onOpenChange={(nextOpen) => {
                // Escape, the close button, and an outside click all mean "I did not ask for this".
                if (!nextOpen) resolveConfirm(false);
            }}
        >
            {request && labels && (
                <DialogContent
                    ref={contentReference}
                    className="confirmation-dialog"
                    // The confirming action takes initial focus so Enter answers the question the title just asked.
                    // The safe-default-focus rule `FileConflictDialog` follows applies to irreversible choices;
                    // destructive commands do not use this dialog at all (DESIGN.md "Confirmations").
                    initialFocus={() =>
                        contentReference.current?.querySelector<HTMLButtonElement>(
                            '[data-confirmation-confirm]',
                        ) ?? null
                    }
                >
                    <DialogHeader>
                        <DialogTitle>{request.title}</DialogTitle>
                        <DialogDescription>{request.message}</DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2 p-4">
                        <Button variant="secondary" onClick={() => resolveConfirm(false)}>
                            {labels.cancel}
                        </Button>
                        <Button data-confirmation-confirm onClick={() => resolveConfirm(true)}>
                            {labels.confirm}
                        </Button>
                    </div>
                </DialogContent>
            )}
        </Dialog>
    );
}
