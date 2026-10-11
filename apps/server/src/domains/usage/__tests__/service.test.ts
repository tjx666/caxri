import { describe, expect, it } from 'vitest';

import type { DiscoveredTranscript } from '../external';
import { describeOutsideTranscripts, reportedPendingScans } from '../service';

describe('reportedPendingScans', () => {
    it('reports a scan still discovering transcripts as pending', () => {
        expect(reportedPendingScans(true, 0)).toBe(1);
        expect(reportedPendingScans(true, 40)).toBe(40);
    });

    it('reports nothing pending once the scan finished', () => {
        expect(reportedPendingScans(false, 3)).toBe(0);
    });
});

describe('describeOutsideTranscripts', () => {
    it('never stats more than the scan concurrency of outside transcripts at once', async () => {
        const queue = Array.from({ length: 200 }, (_, index): DiscoveredTranscript => ({
            provider: 'codex',
            transcriptId: `transcript-${index}`,
            agentSessionId: `session-${index}`,
            main: {
                baseRoot: '/transcripts',
                path: `/transcripts/session-${index}.jsonl`,
                root: '/transcripts',
            },
            isContinuation: false,
        }));
        let active = 0;
        let peak = 0;
        const described = await describeOutsideTranscripts(queue, async (_provider, main) => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 0));
            active -= 1;
            return { main, side: [], fingerprint: main.path };
        });
        expect(peak).toBeLessThanOrEqual(4);
        expect(described.map((item) => item.transcript.transcriptId)).toEqual(
            queue.map((transcript) => transcript.transcriptId),
        );
    });
});
