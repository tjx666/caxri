import { useState } from 'react';

import type { UsageReportParameters } from '@caxri/protocol';
import { keepPreviousData } from '@tanstack/react-query';

import { usePolledQuery } from '../../hooks/use-polled-query';

/**
 * The report rescans only transcripts whose size or mtime changed, so a refresh while the page is visible costs tens of
 * milliseconds; a minute keeps today's figures current during an active Session.
 */
const REFRESH_INTERVAL_MS = 60_000;
/**
 * While the first read of transcripts outside Caxri runs in the Server (about a minute for years of history), the
 * figures fill in quickly enough that a minute between refreshes would read as a stuck page.
 */
const SCANNING_REFRESH_INTERVAL_MS = 2_000;

/**
 * The Usage page's polled report, refreshed faster while the Server is still reading transcripts outside Caxri.
 */
export function useUsageReport(parameters: UsageReportParameters) {
    const [isScanning, setIsScanning] = useState(false);
    const query = usePolledQuery('usage.report', parameters, {
        label: 'Usage page report',
        intervalMs: isScanning ? SCANNING_REFRESH_INTERVAL_MS : REFRESH_INTERVAL_MS,
        placeholderData: keepPreviousData,
    });
    const isScanningNow = (query.data?.coverage.outsideCaxri?.pendingScans ?? 0) > 0;
    // Adjusting state while rendering (not in an effect) re-renders once with the new cadence before committing.
    if (isScanningNow !== isScanning) setIsScanning(isScanningNow);
    return query;
}
