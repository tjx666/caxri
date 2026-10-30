import type { Theme } from 'expo-router';

import type { MobileTheme } from './tokens';

/**
 * The react-navigation colors for the mobile theme. Without them the Stacks fall back to react-navigation's light
 * `DefaultTheme`, whose near-white `background` paints every screen and the stack container beneath the dark content,
 * so a frame the content has not drawn yet (such as a slow frame of a Back transition) flashes white.
 */
export const mobileNavigationColors = (theme: MobileTheme): Theme['colors'] => ({
    background: theme.background,
    border: theme.border,
    card: theme.surface,
    notification: theme.danger,
    primary: theme.primary,
    text: theme.text,
});
