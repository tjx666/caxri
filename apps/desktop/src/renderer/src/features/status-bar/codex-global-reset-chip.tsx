import { RotateCcw } from 'lucide-react';

import { useClockTick } from '@/hooks/use-clock-tick';
import { usePolledQuery } from '@/hooks/use-polled-query';

import { StructuredTooltip } from '../../components/structured-tooltip';
import { useTranslation } from '../../i18n';
import { useCaxriQuery } from '../../queries/client';
import { codexGlobalResetChipCopy, isCodexAvailable } from './codex-global-reset-label';
import { StatusItem } from './status-item';

/**
 * Main caches the tracker for five minutes, so polling at that pace costs one request per window of that length.
 */
const CODEX_GLOBAL_RESET_POLL_MS = 5 * 60_000;

/**
 * Counts down to an announced Codex global reset and opens the announcement on click. Shown only while a dated
 * announcement is pending and Codex is installed, so it never holds a slot to say "no reset".
 */
export function CodexGlobalResetChip() {
    const { t } = useTranslation();
    // False until the availability answer arrives, so a machine without Codex never asks the tracker at all.
    const { data: isCodexInstalled = false } = useCaxriQuery(
        'agentAvailability.get',
        {},
        { retry: false, select: isCodexAvailable, staleTime: CODEX_GLOBAL_RESET_POLL_MS },
    );
    const { data } = usePolledQuery(
        'codexGlobalReset.read',
        {},
        {
            label: 'codexGlobalReset.read',
            intervalMs: CODEX_GLOBAL_RESET_POLL_MS,
            staleTime: CODEX_GLOBAL_RESET_POLL_MS / 2,
            retry: false,
            enabled: isCodexInstalled,
        },
    );
    const now = useClockTick('minute');
    const copy = isCodexInstalled ? codexGlobalResetChipCopy(data, now, t) : undefined;
    if (!copy) return null;
    return (
        <StatusItem
            ariaLabel={copy.ariaLabel}
            className="statusbar-codex-global-reset"
            href={copy.postUrl}
            icon={<RotateCcw />}
            interactiveTitle
            title={<StructuredTooltip {...copy.tooltip} />}
        >
            {copy.label}
        </StatusItem>
    );
}
