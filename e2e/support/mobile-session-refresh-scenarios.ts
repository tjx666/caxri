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
async function sessionReadCount(path: string): Promise<number> {
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    return lines.filter((line) => {
        const record = JSON.parse(line) as { event?: string; fields?: { method?: string } };
        return record.event === 'ipc.request' && record.fields?.method === 'mobile.session.show';
    }).length;
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
        const log = join(fixture.testDirectory, 'user-data', 'logs', 'server-core.jsonl');
        const before = await waitForMobile(
            () => sessionReadCount(log),
            (count) => count > 0,
        );
        const startedAt = Date.now();
        /**
         * The criterion measures an entire idle minute, including any periodic refresh.
         */
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        const elapsedMs = Date.now() - startedAt;
        const idleReads = (await sessionReadCount(log)) - before;
        expect(idleReads).toBeLessThanOrEqual(2);
        const title = 'Synthetic pushed Session';
        const changedAt = Date.now();
        await pageRequest(fixture.running.page, 'session.rename', {
            sessionId,
            displayTitle: title,
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
                    initialReads: before,
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
