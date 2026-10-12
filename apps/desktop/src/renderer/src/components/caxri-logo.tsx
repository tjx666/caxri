import caxriLogoUrl from '../assets/caxri-logo.png';
import { cn } from '../lib/utilities';

/**
 * Vite serves this repo-only asset in development without bundling it into production.
 */
const logoUrl = import.meta.env.DEV ? '/src/assets/caxri-logo-dev.png' : caxriLogoUrl;

/**
 * The app mark a window title bar shows in macOS fullscreen: fullscreen hides the traffic lights, and the logo anchors
 * the header in their absence.
 */
export function CaxriLogo({ className }: { className?: string }) {
    return (
        <img
            src={logoUrl}
            alt="Caxri"
            className={cn('h-7 w-7 flex-none object-contain', className)}
            data-caxri-logo
        />
    );
}
