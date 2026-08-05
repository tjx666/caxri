import type { CSSProperties } from 'react';

import type { ThemeTokens } from '@shared/types';

interface ThemePreviewProps {
    theme: ThemeTokens;
}

type PreviewStyle = CSSProperties & Record<`--preview-${string}`, string>;

export function ThemePreview({ theme }: ThemePreviewProps) {
    const style: PreviewStyle = {
        '--preview-accent': theme.colors.accent,
        '--preview-background': theme.terminal.background,
        '--preview-blue': theme.terminal.blue,
        '--preview-border': theme.colors.border,
        '--preview-cyan': theme.terminal.cyan,
        '--preview-foreground': theme.terminal.foreground,
        '--preview-green': theme.terminal.green,
        '--preview-muted': theme.colors.muted,
        '--preview-surface': theme.colors.surface,
        '--preview-yellow': theme.terminal.yellow,
    };

    return (
        <section className="theme-preview" style={style} aria-label="Theme preview">
            <header>
                <span />
                <strong>~/code/caxri</strong>
                <i>Terminal</i>
            </header>
            <div className="theme-preview-terminal">
                <p>
                    <b>❯</b> <span>git status --short</span>
                </p>
                <p className="preview-status">
                    <em>M</em> src/renderer/src/App.tsx
                </p>
                <p>
                    <b>❯</b> <span>bun run dev</span>
                </p>
                <p className="preview-success">ready in 84 ms</p>
            </div>
            <footer>
                <span>main</span>
                <span>TypeScript</span>
                <span>UTF-8</span>
            </footer>
        </section>
    );
}
