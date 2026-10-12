import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TranscriptScanCursor } from '../transcript-scan';
import { scanTranscriptToEnd } from '../transcript-scan';
import type { AgentTranscriptLocation } from '../transcript-security';

/**
 * One pass reads at most 4 MiB, so a transcript of 12 MiB in 64 KiB records needs three passes.
 */
const RECORD = `${'x'.repeat(64 * 1024 - 1)}\n`;
const RECORD_COUNT = 192;
const ONE_PASS_BYTES = 4 * 1024 * 1024;

describe('scanTranscriptToEnd', () => {
    let home: string;
    let location: AgentTranscriptLocation;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'caxri-transcript-scan-'));
        const baseRoot = join(home, 'sessions');
        const root = join(baseRoot, 'project');
        await mkdir(root, { recursive: true });
        location = { baseRoot, root, path: join(root, 'transcript.jsonl') };
        await writeFile(location.path, RECORD.repeat(RECORD_COUNT));
    });

    afterEach(async () => {
        await rm(home, { force: true, recursive: true });
    });

    it('reads a transcript longer than one pass to its end', async () => {
        const cursor: TranscriptScanCursor = { offset: 0 };
        let records = 0;
        await scanTranscriptToEnd(location, cursor, (line) => {
            if (line) records += 1;
        });
        expect(records).toBe(RECORD_COUNT);
        expect(cursor.offset).toBe(RECORD.length * RECORD_COUNT);
    });

    it('stops at the pass boundary after its signal aborts', async () => {
        const controller = new AbortController();
        const cursor: TranscriptScanCursor = { offset: 0 };
        let records = 0;
        await scanTranscriptToEnd(
            location,
            cursor,
            (line) => {
                if (line) records += 1;
                controller.abort();
            },
            { signal: controller.signal },
        );
        expect(records).toBeGreaterThan(0);
        expect(records).toBeLessThanOrEqual(ONE_PASS_BYTES / RECORD.length);
        expect(cursor.offset).toBeLessThanOrEqual(ONE_PASS_BYTES);
    });

    it('reads nothing once its signal has already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const cursor: TranscriptScanCursor = { offset: 0 };
        let lines = 0;
        await scanTranscriptToEnd(
            location,
            cursor,
            () => {
                lines += 1;
            },
            { signal: controller.signal },
        );
        expect(lines).toBe(0);
        expect(cursor.offset).toBe(0);
    });
});
