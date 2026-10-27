import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonAtomic } from '../../scripts/atomic-json';
import { expect } from './fixtures';
import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import {
    captureMobileFramebuffer,
    mobileSemantics,
    observeMobileNode,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';

interface Environment {
    artifactManifestPath: string;
    assetsDirectory: string;
    caseId: string;
    scenarioReceiptPath: string;
    serial: string;
}

/**
 * Reads only method metadata; the report contains counts rather than raw log records.
 */
async function sessionReadSummary(
    path: string,
): Promise<{ count: number; timestamp: number } | undefined> {
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    for (const line of lines.toReversed()) {
        const record = JSON.parse(line) as {
            event?: string;
            timestamp?: string;
            fields?: { sessionReads?: number };
        };
        if (
            record.event === 'mobile_gateway.session_read_summary' &&
            typeof record.fields?.sessionReads === 'number'
        )
            return {
                count: record.fields.sessionReads,
                timestamp: Date.parse(record.timestamp ?? ''),
            };
    }
    return undefined;
}

export async function executeMobileSessionRefreshScenario(
    environment: Environment,
    artifacts: string[],
): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'launch-failure',
        serial: environment.serial,
    });
    try {
        await fixture.pair();
        const sessionId = fixture.allowedSessionId;
        if (!sessionId) throw new Error('Session refresh fixture is unavailable');
        await tapMobileCheck(environment.serial, `session-row-${sessionId}`);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'session-detail-title'),
        );
        /**
         * Metadata evidence must not capture the fallback shell's host-specific prompt. Keep this detail mounted on
         * Project throughout the measurement and final capture.
         */
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'session-segment-panel-caxri.files'),
        );
        await tapMobileCheck(environment.serial, 'session-segment-panel-caxri.files');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'files-panel'),
        );
        /**
         * The detail fallback is used only after the bounded dashboard no longer contains this Session.
         */
        for (let index = 0; index < 64; index++) {
            // eslint-disable-next-line no-await-in-loop -- Serialized writes avoid flooding the shared Server queue.
            await pageRequest(fixture.running.page, 'session.create', {
                projectId: fixture.allowedProjectId,
                defaultAgent: null,
            });
        }
        const log = join(fixture.testDirectory, 'user-data', 'logs', 'server-core.jsonl');
        const before = await waitForMobile(
            () => sessionReadSummary(log),
            (summary) => summary !== undefined && summary.count > 0,
        );
        if (!before) throw new Error('Mobile Session read summary is unavailable');
        const after = await waitForMobile(
            () => sessionReadSummary(log),
            (summary) => summary !== undefined && summary.timestamp >= before.timestamp + 60_000,
            75_000,
        );
        if (!after) throw new Error('Mobile Session idle summary is unavailable');
        const elapsedMs = after.timestamp - before.timestamp;
        const idleReads = after.count - before.count;
        expect(idleReads).toBeLessThanOrEqual(2);
        const title = 'Synthetic pushed Session';
        const changedAt = Date.now();
        await pageRequest(fixture.running.page, 'session.rename', {
            sessionId,
            title,
        });
        await waitForMobile(
            () =>
                observeMobileNode(environment.serial, 'session-detail-title', {
                    kind: 'equals',
                    value: title,
                }),
            (observation) => observation.textMatches === true,
            10_000,
        );
        const updateObservedMs = Date.now() - changedAt;
        const name = `${environment.caseId}-updated-android.png`;
        await captureMobileFramebuffer(environment.serial, join(environment.assetsDirectory, name));
        artifacts.push(`assets/${name}`);
        await writeJsonAtomic(environment.artifactManifestPath, { artifacts, schemaVersion: 1 });
        await writeFile(
            environment.scenarioReceiptPath,
            `${JSON.stringify(
                {
                    caseId: environment.caseId,
                    schemaVersion: 1,
                    elapsedMs,
                    idleReads,
                    initialReads: before.count,
                    fixedIntervalBaseline: {
                        intervalMs: 2_500,
                        expectedReadsPerMinute: 24,
                        kind: 'calculated',
                    },
                    updateObservedMs,
                    status: 'passed',
                },
                null,
                2,
            )}\n`,
            'utf8',
        );
    } finally {
        await fixture.stop();
    }
}
