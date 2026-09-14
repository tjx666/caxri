import { ContextMenuItem } from '../../components/ui/context-menu';
import { copyFilePath } from '../../lib/copy-file-path';
import type { DocumentTabPathResolution } from './document-tab-path-actions';

function discard(promise: Promise<unknown>): void {
    // eslint-disable-next-line no-void -- intentional floating-promise discard; the action reports its own errors via toast
    void promise;
}

/**
 * Renders the same path resolution used by Editor drags. External documents have no Project-relative path, while
 * ordinary files and single-file diffs use the authorized repository root supplied by their caller.
 */
export function DocumentTabPathMenu({
    resolution,
    unavailableReason,
    isExternal,
}: {
    resolution?: DocumentTabPathResolution;
    unavailableReason: string;
    isExternal: boolean;
}) {
    return (
        <>
            <ContextMenuItem
                disabled={!resolution}
                disabledReason={!resolution ? unavailableReason : undefined}
                onClick={() => {
                    if (resolution) discard(copyFilePath(resolution.absolutePath));
                }}
            >
                Copy Path
            </ContextMenuItem>
            {!isExternal && (
                <ContextMenuItem
                    disabled={!resolution?.relativeRoot}
                    disabledReason={!resolution?.relativeRoot ? unavailableReason : undefined}
                    onClick={() => {
                        if (resolution?.relativeRoot)
                            discard(copyFilePath(resolution.absolutePath, resolution.relativeRoot));
                    }}
                >
                    Copy Relative Path
                </ContextMenuItem>
            )}
        </>
    );
}
