import { CircleSlash, TriangleAlert } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../components/ui/empty';
import type { EditorLoadTone } from './editor-load-state';

/**
 * Shared shape for the editor area's non-happy states: what happened, in plain language, plus the one action that can
 * recover from it. A real failure is announced through `role="alert"` because the surface it replaces was a spinner the
 * user was already watching; an interruption is not, since the user did not ask for anything to go wrong and nothing
 * about it is urgent.
 *
 * Every editor surface that can fail renders through this one component, so a reader learns a single visual language
 * for "this did not work" across the file editor, the diff, and anything added later.
 */
export function EditorLoadFailure({
    actionLabel,
    reason,
    tone = 'failed',
    onAction,
}: {
    actionLabel: string;
    reason: string;
    tone?: EditorLoadTone;
    onAction: () => void;
}) {
    const isFailure = tone === 'failed';
    return (
        <Empty className="empty-work h-full flex-1" role={isFailure ? 'alert' : undefined}>
            <EmptyMedia>
                {isFailure ? (
                    <TriangleAlert aria-hidden="true" className="text-danger" size={28} />
                ) : (
                    <CircleSlash aria-hidden="true" className="text-muted" size={28} />
                )}
            </EmptyMedia>
            <EmptyTitle className="max-w-80 text-pretty">{reason}</EmptyTitle>
            <Button size="sm" variant="secondary" onClick={onAction}>
                {actionLabel}
            </Button>
        </Empty>
    );
}
