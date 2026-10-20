import type { AppSettings } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';

import { useShouldReduceMotion } from '../../../hooks/use-should-reduce-motion';
import { useSettings } from '../../../stores/selectors';
import type { WorkingIndicator } from './presentation';

/**
 * The Chat's working animation settings. `animatesToolIcons` is also off under Reduce Motion: a still live glyph is a
 * frozen mid-pose drawing, and the web glyph's SMIL motion ignores CSS media queries, so callers show the still icon.
 */
export function useLoadingStyle(): {
    animatesToolIcons: boolean;
    statusShimmer: AppSettings['agentChat.statusShimmer'];
    workingIndicator: WorkingIndicator;
} {
    const settings = useSettings() ?? defaultAppSettings;
    const shouldReduceMotion = useShouldReduceMotion();
    return {
        animatesToolIcons: settings['agentChat.animatedToolIcons'] && !shouldReduceMotion,
        statusShimmer: settings['agentChat.statusShimmer'],
        workingIndicator: settings['agentChat.workingIndicator'],
    };
}
