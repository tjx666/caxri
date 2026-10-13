import {
    Bot,
    ChartColumn,
    ChartScatter,
    Gauge,
    Layers,
    Settings,
    SquareTerminal,
} from 'lucide-react';

/**
 * Built-in glyphs for tabs that show neither a file nor an Agent. Settings takes the gear: the sliders glyph is the
 * Settings page's own "UI" view toggle, and one glyph meaning two things on one screen read as a duplicate.
 */
export const WORK_TAB_GLYPHS = {
    'settings': Settings,
    'usage': ChartColumn,
    'benchmark': ChartScatter,
    'agent-task': Bot,
    'shell-task': SquareTerminal,
    'agent-status': Gauge,
    'agent-context': Layers,
} as const;

export function isWorkTabGlyph(icon: string): icon is WorkTabGlyph {
    return Object.hasOwn(WORK_TAB_GLYPHS, icon);
}

export type WorkTabGlyph = keyof typeof WORK_TAB_GLYPHS;
