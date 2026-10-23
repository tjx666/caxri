/**
 * The slice of the Battery Status API this module reads. Chromium on macOS reports `charging` as "on AC power", so a
 * full battery on the charger still counts as charging.
 *
 * @see https://developer.mozilla.org/docs/Web/API/BatteryManager
 */
interface BatteryState extends EventTarget {
    readonly charging: boolean;
}

/**
 * Publishes `data-power="battery"` on the document element while the machine runs on battery, so decorative motion can
 * lower its frame rate in CSS alone (Buddy's `--buddy-rate`, `loading.css`). The attribute is absent on AC power and
 * wherever the Battery Status API is unavailable, which keeps full-rate motion the default.
 *
 * The Renderer reads the Battery Status API instead of Main's `powerMonitor` because the state only styles motion: it
 * needs no Main round trip or protocol event, and every window observes it on its own like `observeWindowActive`.
 *
 * @returns A teardown that stops publishing power changes.
 */
export function observePowerSource(): () => void {
    let battery: BatteryState | undefined;
    let isStopped = false;
    const publish = (): void => {
        if (battery?.charging === false) document.documentElement.dataset.power = 'battery';
        else delete document.documentElement.dataset.power;
    };
    const subscribe = async (): Promise<void> => {
        const getBattery = (navigator as { getBattery?: () => Promise<BatteryState> }).getBattery;
        if (!getBattery) return;
        let state: BatteryState;
        try {
            state = await getBattery.call(navigator);
        } catch {
            return;
        }
        if (isStopped) return;
        battery = state;
        publish();
        state.addEventListener('chargingchange', publish);
    };
    // eslint-disable-next-line no-void -- `subscribe` handles its own failure; nothing awaits the first reading.
    void subscribe();
    return () => {
        isStopped = true;
        battery?.removeEventListener('chargingchange', publish);
    };
}
