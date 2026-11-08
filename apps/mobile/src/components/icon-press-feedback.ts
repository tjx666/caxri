import { Platform } from 'react-native';

import type { MobileTheme } from '../theme/tokens';

/**
 * The radius of a glyph-only control's Android press ripple: a 40dp circle around the glyph, as Material icon buttons
 * draw it, regardless of the control's slightly larger layout box.
 */
const ICON_RIPPLE_RADIUS = 20;

/**
 * The press feedback every glyph-only control shares. Android draws a borderless ripple, because the opacity dip alone
 * barely reads on a dark header; iOS keeps the opacity dip, its native feedback for a bare glyph.
 */
export const iconPressFeedback = (theme: MobileTheme) =>
    Platform.OS === 'android'
        ? {
              android_ripple: {
                  borderless: true,
                  color: theme.ripple,
                  radius: ICON_RIPPLE_RADIUS,
              },
              pressedOpacity: 1,
          }
        : { android_ripple: undefined, pressedOpacity: 0.6 };
