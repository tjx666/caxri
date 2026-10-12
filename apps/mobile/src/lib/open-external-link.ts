import { Alert, Linking } from 'react-native';

export const OPEN_LINK_FAILED_TITLE = "Couldn't open link";

/**
 * Opens a web link in the system browser and tells the reader when the system refuses it, instead of a tap that
 * silently does nothing. `open` and `report` default to the platform and exist so the failure path is testable.
 */
export const openExternalLink = async (
    url: string,
    {
        open = (target: string) => Linking.openURL(target),
        report = (title: string, message: string) => Alert.alert(title, message),
    }: {
        open?: (target: string) => Promise<unknown>;
        report?: (title: string, message: string) => void;
    } = {},
): Promise<void> => {
    try {
        await open(url);
    } catch {
        report(OPEN_LINK_FAILED_TITLE, `No app on this device could open ${url}.`);
    }
};
