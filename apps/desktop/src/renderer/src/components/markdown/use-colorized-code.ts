import { useEffect, useState } from 'react';

import { colorizeCode } from '../../lib/code-colorize';
import { useTheme } from '../../stores/selectors';

/**
 * The editor-colored markup for a fenced block, or `undefined` until it is ready, while `isEnabled` is false, or when
 * the fence names no language Monaco knows. A block still streaming passes `isEnabled: false`: re-tokenizing a growing
 * block on every delta costs more than it shows, and it is painted once its fence closes.
 */
export function useColorizedCode(
    code: string,
    language: string | undefined,
    isEnabled: boolean,
): string | undefined {
    const theme = useTheme();
    const [painted, setPainted] = useState<{ key: string; html: string | undefined }>();
    const key = `${language ?? ''}\0${code}`;
    useEffect(() => {
        if (!isEnabled || !language) return;
        let isCurrent = true;
        const paint = async (): Promise<void> => {
            try {
                const html = await colorizeCode(code, language, theme);
                if (isCurrent) setPainted({ key, html });
            } catch {
                // An unpaintable block keeps its plain-text rendering.
            }
        };
        // eslint-disable-next-line no-void -- `paint` handles its own failure
        void paint();
        return () => {
            isCurrent = false;
        };
    }, [code, isEnabled, key, language, theme]);
    return painted?.key === key ? painted.html : undefined;
}
