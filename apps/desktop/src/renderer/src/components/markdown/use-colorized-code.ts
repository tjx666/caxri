import { useEffect, useState } from 'react';

import { codeLanguageName, colorizeCode } from '../../lib/code-colorize';
import { useTheme } from '../../stores/selectors';

interface ColorizedCode {
    html?: string;
    /**
     * Monaco's display name for the language, such as `TypeScript` for a `ts` fence.
     */
    languageName?: string;
}

/**
 * The editor-colored markup for a fenced block and its language's display name, each `undefined` until it is ready,
 * while `isEnabled` is false, or when the fence names no language Monaco knows. A block still streaming passes
 * `isEnabled: false`: re-tokenizing a growing block on every delta costs more than it shows, and it is painted once its
 * fence closes.
 */
export function useColorizedCode(
    code: string,
    language: string | undefined,
    isEnabled: boolean,
): ColorizedCode {
    const theme = useTheme();
    const [painted, setPainted] = useState<{ key: string } & ColorizedCode>();
    const key = `${language ?? ''}\0${code}`;
    useEffect(() => {
        if (!isEnabled || !language) return;
        let isCurrent = true;
        const paint = async (): Promise<void> => {
            try {
                const [html, languageName] = await Promise.all([
                    colorizeCode(code, language, theme),
                    codeLanguageName(language),
                ]);
                if (isCurrent) setPainted({ key, html, languageName });
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
    return painted?.key === key ? painted : {};
}
