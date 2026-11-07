import { useRef, useState } from 'react';

import { Cloud, Route, Wifi } from 'lucide-react-native';

import { BottomSheet, SheetAction, SheetCancel, SheetTitle } from '../../components/bottom-sheet';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileClient } from '../connection/mobile-client-provider';
import type { MobileRoutePreference } from '../connection/route-preference';
import { mobileRoutePreferences } from '../connection/route-preference';
import { routePreferenceDetails } from './settings-model';
import { SettingsRow } from './settings-rows';

const icons = { auto: Route, direct: Wifi, relay: Cloud } as const;

/**
 * "Connection method" under THIS DEVICE: pins reconnects to direct addresses or the Relay, or leaves the race
 * automatic. A choice applies after the sheet slides away, and reconnects at once when the live connection took the
 * other path.
 */
export const RoutePreferenceRow = ({
    isLast = false,
    theme,
}: {
    isLast?: boolean;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { routePreference, setRoutePreference } = useMobileClient();
    const [isOpen, setIsOpen] = useState(false);
    const picked = useRef<MobileRoutePreference | null>(null);
    const current = routePreferenceDetails(routePreference, t);
    return (
        <>
            <SettingsRow
                accessibilityHint={t('settings.route.hint')}
                detail={current.description}
                isLast={isLast}
                label={t('settings.route')}
                onPress={() => {
                    picked.current = null;
                    setIsOpen(true);
                }}
                showsChevron
                testID="settings-connection-method"
                theme={theme}
                value={current.label}
            />
            {isOpen ? (
                <BottomSheet
                    closeLabel={t('settings.route.close')}
                    onClose={() => {
                        setIsOpen(false);
                        const next = picked.current;
                        if (next && next !== routePreference) void setRoutePreference(next);
                    }}
                    testID="connection-method-sheet"
                    theme={theme}
                >
                    {(dismiss) => (
                        <>
                            <SheetTitle theme={theme} title={t('settings.route')} />
                            {mobileRoutePreferences.map((preference) => {
                                const details = routePreferenceDetails(preference, t);
                                return (
                                    <SheetAction
                                        detail={details.description}
                                        icon={icons[preference]}
                                        key={preference}
                                        label={details.label}
                                        onPress={() => {
                                            picked.current = preference;
                                            dismiss();
                                        }}
                                        selected={preference === routePreference}
                                        testID={`connection-method-${preference}`}
                                        theme={theme}
                                    />
                                );
                            })}
                            <SheetCancel
                                onPress={dismiss}
                                testID="connection-method-cancel"
                                theme={theme}
                            />
                        </>
                    )}
                </BottomSheet>
            ) : null}
        </>
    );
};
