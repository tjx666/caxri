import { Bug } from 'lucide-react';

import { StructuredTooltip } from '../../components/structured-tooltip';
import { useCaxriQuery } from '../../queries/client';
import { openSettings } from '../../stores/dialogs';
import { remoteDebuggingChipCopy } from './remote-debugging-label';
import { StatusItem } from './status-item';

/**
 * Standing disclosure that this instance is reachable by a debugger. Muted tokens per DESIGN.md's status bar redline —
 * a coloured chip is reserved for a degraded Caxri, and an open debugging channel is a mode the user (or the build)
 * chose, like Screencast Mode, not a failure.
 *
 * The query reports what the running process is actually doing, not `argv.jsonc`'s `remoteDebugging`: turning the
 * switch off leaves the port open until the next launch, and an unpackaged build listens whatever the file says. Both
 * are settled at boot, so one read per window is enough.
 */
export function RemoteDebuggingChip() {
    const { data } = useCaxriQuery('argv.get', undefined, { staleTime: Infinity });
    const copy = data && remoteDebuggingChipCopy(data.remoteDebugging);
    if (!copy) return null;
    return (
        <StatusItem
            icon={<Bug />}
            ariaLabel={copy.description}
            title={<StructuredTooltip {...copy.tooltip} />}
            className="text-muted"
            onClick={() => openSettings('remote-debugging')}
        >
            {copy.text}
        </StatusItem>
    );
}
