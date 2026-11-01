import { useDeviceActions } from './use-device-actions';

/**
 * Renders nothing; mounted once under `MobileClientProvider` so actions are heard on every screen.
 */
export const DeviceActionListener = () => {
    useDeviceActions();
    return null;
};
