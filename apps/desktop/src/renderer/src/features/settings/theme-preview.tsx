import type { CSSProperties } from 'react';

import type { ThemeTokens } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';

interface ThemePreviewProperties {
    theme: ThemeTokens;
}

type PreviewStyle = CSSProperties & Record<`--preview-${string}`, string>;

// Header and footer strips share the preview-surface fill and 8px row gap.
const previewBarClassName = 'flex items-center gap-2 bg-[var(--preview-surface)] px-2 py-1';

export function ThemePreview({ theme }: ThemePreviewProperties) {
    const { t } = useTranslation();
    const style: PreviewStyle = {
        '--preview-accent': theme.colors.accent,
        '--preview-background': theme.terminal.background,
        '--preview-blue': theme.terminal.blue,
        '--preview-border': theme.colors.border,
        '--preview-chrome-foreground': theme.colors.foreground,
        '--preview-cyan': theme.terminal.cyan,
        '--preview-foreground': theme.terminal.foreground,
        '--preview-green': theme.terminal.green,
        '--preview-muted': theme.colors.muted,
        '--preview-surface': theme.colors.surface,
        '--preview-yellow': theme.terminal.yellow,
    };

    return (
        <section
            className="mb-4 overflow-hidden rounded-md border border-[var(--preview-border)] bg-[var(--preview-background)] font-['Caxri_JetBrains_Mono',_monospace] text-[11px] leading-[1.5] text-[var(--preview-foreground)] shadow-[0_8px_24px_var(--shadow)]"
            style={style}
            aria-label={t('settings.themeEditor.preview')}
        >
            <header
                className={cn(
                    previewBarClassName,
                    'border-b border-[var(--preview-border)] text-[var(--preview-chrome-foreground)]',
                )}
            >
                <span className="size-2 rounded-full bg-[var(--preview-accent)]" />
                <strong className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                    ~/code/caxri
                </strong>
                <i className="text-[var(--preview-muted)] not-italic">
                    {t('settings.themeEditor.previewTerminal')}
                </i>
            </header>
            <div className="min-h-28 p-3">
                <p className="mb-1">
                    <b className="text-[var(--preview-cyan)]">❯</b>{' '}
                    <span className="text-[var(--preview-yellow)]">git status --short</span>
                </p>
                <p className="mb-1">
                    <em className="text-[var(--preview-blue)] not-italic">M</em>{' '}
                    src/renderer/src/app.tsx
                </p>
                <p className="mb-1">
                    <b className="text-[var(--preview-cyan)]">❯</b>{' '}
                    <span className="text-[var(--preview-yellow)]">bun run dev</span>
                </p>
                <p className="mb-1 text-[var(--preview-green)]">ready in 84 ms</p>
            </div>
            <footer
                className={cn(
                    previewBarClassName,
                    'justify-between border-t border-[var(--preview-border)] text-[10px] text-[var(--preview-muted)]',
                )}
            >
                <span>main</span>
                <span>TypeScript</span>
                <span>UTF-8</span>
            </footer>
        </section>
    );
}
