import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { allowE2EErrors } from './error-gate.ts';
import { expect } from './fixtures.ts';
import { pageRequest } from './helpers.ts';
import { waitForMobile } from './mobile-android.ts';
import type { ScenarioEnvironment } from './mobile-conversation-scenarios.ts';
import {
    conversationFixture,
    finish,
    itemIdDigests,
    opaqueDigest,
    openConversation,
    scrollToConversationId,
} from './mobile-conversation-scenarios.ts';
import {
    conversationAgentRecords,
    conversationBaselineRecords,
} from './mobile-conversation-transcript.ts';

/**
 * `MOB-TIMELINE-01`: the paired-device timeline read, its pagination, isolation between paired devices, and cursor
 * rotation, checked through a synthetic gateway beside the phone's own pairing.
 */
export async function executeMobileTimelineScenario(
    environment: ScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const fixture = await conversationFixture(environment.serial);
    let gateway: Awaited<ReturnType<typeof fixture.pairTimelineGateway>> | undefined;
    let subscription: { unsubscribe(): Promise<void> } | undefined;
    try {
        await fixture.appendTranscript(conversationBaselineRecords());
        const androidPairing = await fixture.pair();
        gateway = await fixture.pairTimelineGateway();
        const syntheticDeviceId = gateway.deviceId;
        const pairedDevices = await pageRequest<{
            devices: Array<{
                deviceId: string;
                projectIds: string[];
                revokedAt?: number;
            }>;
        }>(fixture.running.page, 'mobile.device.list');
        const activeDevices = pairedDevices.devices.filter(
            ({ revokedAt }) => revokedAt === undefined,
        );
        const androidGrant = activeDevices.find(
            ({ deviceId }) => deviceId === androidPairing.deviceId,
        );
        const syntheticGrant = activeDevices.find(({ deviceId }) => deviceId === syntheticDeviceId);
        if (
            activeDevices.length !== 2 ||
            androidPairing.deviceId === syntheticDeviceId ||
            androidGrant?.projectIds.length !== 1 ||
            androidGrant.projectIds[0] !== fixture.allowedProjectId ||
            syntheticGrant?.projectIds.length !== 1 ||
            syntheticGrant.projectIds[0] !== fixture.allowedProjectId
        ) {
            throw new Error('Timeline paired-device grants are not isolated');
        }
        const first = await gateway.readTimeline({
            sessionId: fixture.allowedSessionId,
            limit: 80,
        });
        const second = await gateway.readTimeline({
            sessionId: fixture.allowedSessionId,
            limit: 80,
        });
        expect(first.status).toBe('available');
        expect(first.items.map(({ type }) => type)).toEqual([
            'userMessage',
            'agentMessage',
            'toolCall',
            'toolCall',
            'toolCall',
            'toolCall',
            'turnBoundary',
        ]);
        expect(second.items.map(({ id }) => id)).toEqual(first.items.map(({ id }) => id));
        const newest = await gateway.readTimeline({
            sessionId: fixture.allowedSessionId,
            limit: 2,
        });
        if (!newest.olderCursor) throw new Error('Timeline pagination cursor is unavailable');
        const older = await gateway.readTimeline({
            sessionId: fixture.allowedSessionId,
            before: newest.olderCursor,
            limit: 3,
        });
        expect(newest.items.map(({ id }) => id)).toEqual(first.items.slice(-2).map(({ id }) => id));
        // The older page is the three items right before the newest two, whatever the
        // fixture's total length is.
        expect(older.items.map(({ id }) => id)).toEqual(
            first.items.slice(-5, -2).map(({ id }) => id),
        );
        if (!fixture.deniedSessionId) throw new Error('Denied fixture Session is unavailable');
        allowE2EErrors([
            {
                source: 'server-core',
                event: 'ipc.request_failed',
                code: 'NOT_FOUND',
                method: 'mobile.timeline.read',
                count: 1,
            },
        ]);
        await expect(
            gateway.readTimeline({
                sessionId: fixture.deniedSessionId,
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await openConversation(environment.serial, fixture.allowedSessionId);
        await scrollToConversationId(environment.serial, 'conversation-user-', 'earlier');
        let changeCount = 0;
        subscription = await gateway.subscribeConversation(fixture.allowedSessionId, (message) => {
            if (message.kind === 'conversation.changed') changeCount += 1;
        });
        await fixture.appendTranscript(conversationAgentRecords(10, 1));
        await waitForMobile(
            () => changeCount,
            (count) => count > 0,
        );
        const appended = await gateway.readTimeline({
            sessionId: fixture.allowedSessionId,
            limit: 80,
        });
        expect(appended.items.length).toBe(first.items.length + 1);
        expect(appended.items.slice(0, first.items.length).map(({ id }) => id)).toEqual(
            first.items.map(({ id }) => id),
        );
        await fixture.replaceTranscript(conversationAgentRecords(60, 2));
        const rotated = await gateway.readTimeline({
            sessionId: fixture.allowedSessionId,
            before: newest.olderCursor,
            limit: 80,
        });
        expect(rotated.cursorExpired).toBe(true);
        expect(rotated.items).toHaveLength(2);
        const serverLog = await readFile(
            join(fixture.testDirectory, 'user-data', 'logs', 'server-core.jsonl'),
            'utf8',
        );
        for (const body of [
            'Summarize this synthetic sample.',
            'Synthetic result',
            'Synthetic update 10.',
        ]) {
            expect(serverLog).not.toContain(body);
        }
        await finish(environment, artifacts, {
            appendedCount: appended.items.length - first.items.length,
            authorizedRead: 'paired-encrypted-gateway',
            beforeCursorDigest: opaqueDigest(newest.olderCursor),
            deniedProject: 'not-found',
            diagnosticLogs: 'synthetic-message-body-absent',
            idStability: 'unchanged-across-rebuild-and-append',
            itemIdDigests: {
                first: itemIdDigests(first.items),
                repeated: itemIdDigests(second.items),
                latest: itemIdDigests(newest.items),
                older: itemIdDigests(older.items),
                appended: itemIdDigests(appended.items),
                rotated: itemIdDigests(rotated.items),
            },
            itemCount: first.items.length,
            itemTypes: first.items.map(({ type }) => type),
            mobileRender: 'allowed-session-conversation',
            notificationCount: changeCount,
            olderPageCount: older.items.length,
            pairedDeviceGrants: {
                activeCount: activeDevices.length,
                androidDeviceIdDigest: opaqueDigest(androidPairing.deviceId),
                syntheticDeviceIdDigest: opaqueDigest(syntheticDeviceId),
                syntheticAuthorizedProjectCount: syntheticGrant.projectIds.length,
            },
            rotation: 'old-cursor-expired',
            status: 'passed',
        });
    } finally {
        await subscription?.unsubscribe();
        gateway?.close();
        await fixture.stop();
    }
}
