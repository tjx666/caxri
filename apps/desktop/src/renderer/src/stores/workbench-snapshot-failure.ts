import { translate } from '../i18n';
import { describeFailure, isCancelledRequest, pushToast } from './toasts';

/**
 * Reports a failed full snapshot read. Every read funnels through one path: the first one that fills an empty window
 * and every later refresh after a command or `state.changed`. Only the first leaves the window without Projects and
 * Sessions; a later failure keeps the last snapshot on screen, so its copy must not claim the window never loaded.
 *
 * Quit refuses every queued Renderer request, so the last `state.changed` before the window closes lands here as a
 * cancellation. Reporting it would raise an error over an application that is already gone; `tryCommand` and
 * `shouldToastQueryError` apply the same rule to the other two failure funnels.
 */
export function reportSnapshotFailure(error: unknown, hasSnapshot: boolean): void {
    if (isCancelledRequest(error)) return;
    pushToast(
        'error',
        describeFailure(
            error,
            translate(
                hasSnapshot
                    ? 'core.workbench.snapshotRefreshFailed'
                    : 'core.workbench.snapshotLoadFailed',
            ),
        ),
    );
}
