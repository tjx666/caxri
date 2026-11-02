import { adbShell } from './mobile-android';

/**
 * The disposable emulator's network interfaces: the app reaches the host over Wi-Fi or the emulated cellular link.
 */
const EMULATOR_INTERFACES = ['wlan0', 'eth0'];

/**
 * Sets the disposable emulator's outgoing network latency in milliseconds (`0` clears it), so a case can replay the
 * round trips a phone pays over the Relay. A local gateway answers within one frame, which hides any ordering that only
 * shows when each request takes a noticeable time.
 *
 * Uses the kernel's `netem` qdisc through the emulator image's `su`: the console's `network delay` command left the
 * guest's round trip to the host under one millisecond.
 */
export const setEmulatorNetworkDelay = async (serial: string, ms: number): Promise<void> => {
    const rule = ms === 0 ? ['del'] : ['replace'];
    const shaping = ms === 0 ? [] : ['netem', 'delay', `${ms}ms`];
    await Promise.all(
        EMULATOR_INTERFACES.map((device) =>
            adbShell(serial, [
                'su',
                '0',
                'tc',
                'qdisc',
                ...rule,
                'dev',
                device,
                'root',
                ...shaping,
            ]),
        ),
    );
};
