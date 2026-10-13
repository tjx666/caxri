import { useCallback, useRef, useSyncExternalStore } from 'react';

import type { UsageLimit } from '@caxri/protocol';

import { subscribeToRelativeTimeClock } from '@/hooks/use-relative-time';

import { useTranslation } from '../../../i18n';
import { agentUsageClockSignature } from '../agent-usage-label';

/**
 * The instant the usage chip judges its limit windows against. It used to read the 2-second poll's `dataUpdatedAt`,
 * which re-rendered the chip and its Tooltip chain on every poll while nothing visible changed. This rides the shared
 * half-minute relative-time clock instead and only hands out a new instant when the windows still current or their
 * reset wording differ ({@link agentUsageClockSignature}), so an idle chip stays still. Without a limit there is nothing
 * time-dependent to show, so it does not subscribe at all.
 */
export function useAgentUsageClock(limit: UsageLimit | undefined): number {
    const { t } = useTranslation();
    const cache = useRef<{ now: number; signature: string }>(undefined);
    const hasLimit = limit !== undefined;
    const subscribe = useCallback(
        (listener: () => void) => (hasLimit ? subscribeToRelativeTimeClock(listener) : () => {}),
        [hasLimit],
    );
    return useSyncExternalStore(subscribe, () => {
        const now = Date.now();
        const signature = agentUsageClockSignature(limit, now, t);
        if (cache.current?.signature !== signature) cache.current = { now, signature };
        return cache.current.now;
    });
}
