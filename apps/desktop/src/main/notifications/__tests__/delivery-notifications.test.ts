import type { ServerEvent } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type {
    AgentSystemNotification,
    AgentSystemNotificationHandle,
} from '../agent-notifications';
import {
    createDeliveryNotificationCoordinator,
    deliveryNotificationText,
} from '../delivery-notifications';

type DeliveryAlert = Extract<ServerEvent, { event: 'projectStatus.alert' }>['payload'];

function alert(overrides: Partial<DeliveryAlert> = {}): ServerEvent {
    return {
        event: 'projectStatus.alert',
        payload: {
            sessionId: 'session-1',
            kind: 'check',
            repository: 'caxri',
            branch: 'feat/example',
            name: 'build',
            url: 'https://github.com/tjx666/caxri/pull/7',
            ...overrides,
        },
    };
}

function harness() {
    const shown: Array<{ notification: AgentSystemNotification; onClick: () => void }> = [];
    const closed: string[] = [];
    const openFailure = vi.fn(async () => {});
    const onError = vi.fn();
    const coordinator = createDeliveryNotificationCoordinator({
        onError,
        openFailure,
        showNotification: (notification, onClick): AgentSystemNotificationHandle => {
            shown.push({ notification, onClick });
            return { close: () => closed.push(notification.id) };
        },
    });
    return { closed, coordinator, onError, openFailure, shown };
}

describe('deliveryNotificationText', () => {
    it('reads a check name as GitHub reports it', () => {
        expect(deliveryNotificationText(alert().payload as DeliveryAlert)).toEqual({
            title: 'caxri · feat/example',
            body: 'CI failed: build',
        });
    });

    it('turns a deployment environment into a sentence', () => {
        const payload = alert({ kind: 'deployment', name: 'preview' }).payload as DeliveryAlert;
        expect(deliveryNotificationText(payload).body).toBe('Preview deployment failed');
    });
});

describe('createDeliveryNotificationCoordinator', () => {
    it('shows one notification per alert', () => {
        const { coordinator, shown } = harness();
        coordinator.observe(alert());
        expect(shown).toHaveLength(1);
        expect(shown[0]?.notification.groupId).toBe('caxri-delivery');
    });

    it('ignores every other server event', () => {
        const { coordinator, shown } = harness();
        coordinator.observe({
            event: 'projectStatus.changed',
            payload: { sessionId: 'session-1' },
        });
        expect(shown).toEqual([]);
    });

    it('gives distinct failures distinct notification ids', () => {
        const { coordinator, shown } = harness();
        coordinator.observe(alert({ name: 'build' }));
        coordinator.observe(alert({ name: 'lint' }));
        expect(new Set(shown.map((entry) => entry.notification.id)).size).toBe(2);
    });

    it('replaces a superseded notification for the same failure instead of stacking it', () => {
        const { closed, coordinator, shown } = harness();
        coordinator.observe(alert());
        coordinator.observe(alert());
        expect(shown).toHaveLength(2);
        expect(closed).toEqual([shown[0].notification.id]);
    });

    it('opens the failure URL when the notification is clicked', async () => {
        const { coordinator, openFailure, shown } = harness();
        coordinator.observe(alert());
        shown[0]?.onClick();
        await vi.waitFor(() =>
            expect(openFailure).toHaveBeenCalledWith('https://github.com/tjx666/caxri/pull/7'),
        );
    });

    it('does nothing on click when the alert carries no URL', () => {
        const { coordinator, openFailure, shown } = harness();
        coordinator.observe(alert({ url: undefined }));
        shown[0]?.onClick();
        expect(openFailure).not.toHaveBeenCalled();
    });

    it('reports a failed open instead of rejecting into Electron', async () => {
        const { coordinator, onError, openFailure, shown } = harness();
        openFailure.mockRejectedValueOnce(new Error('blocked'));
        coordinator.observe(alert());
        shown[0]?.onClick();
        await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    });

    it('reports a delivery failure instead of throwing at the event relay', () => {
        const onError = vi.fn();
        const coordinator = createDeliveryNotificationCoordinator({
            onError,
            openFailure: async () => {},
            showNotification: () => {
                throw new Error('no notification permission');
            },
        });
        expect(() => coordinator.observe(alert())).not.toThrow();
        expect(onError).toHaveBeenCalled();
    });

    it('dismisses live notifications on dispose and ignores later alerts', () => {
        const { closed, coordinator, shown } = harness();
        coordinator.observe(alert());
        coordinator.dispose();
        expect(closed).toEqual([shown[0].notification.id]);
        coordinator.observe(alert({ name: 'lint' }));
        expect(shown).toHaveLength(1);
    });
});
