/**
 * The Settings row's view of Termux commands. `missing` wins over the stored choice, and a stored `on` whose Android
 * permission was later revoked reads as `off`, so the row never claims a capability that would fail.
 */
export type TermuxSettingState = 'unsupported' | 'missing' | 'off' | 'on';

export const termuxSettingState = (facts: {
    isSupported: boolean;
    isInstalled: boolean;
    isEnabled: boolean;
    hasPermission: boolean;
}): TermuxSettingState => {
    if (!facts.isSupported) return 'unsupported';
    if (!facts.isInstalled) return 'missing';
    return facts.isEnabled && facts.hasPermission ? 'on' : 'off';
};
