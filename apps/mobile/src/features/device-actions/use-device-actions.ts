import { useEffect, useState } from 'react';
import { Linking } from 'react-native';

import type { DeviceActionRequest } from '@caxri/protocol';
import { deviceActionRequestSchema } from '@caxri/protocol';
import { router } from 'expo-router';

import { linkTarget } from '../browser/browser-url';
import { useMobileClient } from '../connection/mobile-client-provider';
import type { DeviceActionPorts } from './device-action-handler';
import { runDeviceAction } from './device-action-handler';
import { termuxNative } from './termux-native';

const ports: DeviceActionPorts = {
    isTermuxEnabled: termuxNative.isEnabled,
    runTermux: termuxNative.run,
    // The same rule a tapped link follows (see `openLink`), but a refused external link rejects so the caller hears it.
    openUrl: async (url) => {
        if (linkTarget(url) === 'inApp') router.push({ params: { url }, pathname: '/browser' });
        else await Linking.openURL(url);
    },
};

/**
 * Listens for actions Desktop pushes to this phone (`caxri device open` and `caxri device exec`) while Caxri is
 * connected and in the foreground, runs each, and reports its outcome. A phone in the background is offline for these
 * actions, so the CLI fails at once instead of waiting.
 */
export const useDeviceActions = () => {
    const { connectionEpoch, isForeground, request, status, subscribe, subscriptionAvailable } =
        useMobileClient();
    const isListening = isForeground && status === 'connected' && subscriptionAvailable;
    // Bumped when the Server drops the subscription with `resync-required`, so the effect subscribes again.
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        if (!isListening) return;
        let isDisposed = false;
        let handle: Awaited<ReturnType<typeof subscribe>> | null = null;
        const answer = async ({ actionId, action }: DeviceActionRequest) => {
            const outcome = await runDeviceAction(action, ports);
            try {
                await request('mobile.deviceAction.complete', { actionId, outcome });
            } catch {
                // The CLI caller already moved on (timeout or disconnect); nothing on the phone depends on the answer.
            }
        };
        const attach = async () => {
            try {
                const acquired = await subscribe({ kind: 'deviceActions' }, (message) => {
                    if (isDisposed) return;
                    if (message.kind === 'resync-required') {
                        setAttempt((value) => value + 1);
                        return;
                    }
                    if (message.kind !== 'deviceAction.requested') return;
                    const parsed = deviceActionRequestSchema.safeParse(message.request);
                    // Without a valid action ID there is nothing to answer; the CLI caller times out.
                    if (!parsed.success) return;
                    void answer(parsed.data);
                });
                if (isDisposed) await acquired.unsubscribe();
                else handle = acquired;
            } catch {
                // A failed subscribe leaves this phone offline for device actions until the next connection.
            }
        };
        void attach();
        return () => {
            isDisposed = true;
            if (handle) void handle.unsubscribe();
        };
    }, [attempt, connectionEpoch, isListening, request, subscribe]);
};
