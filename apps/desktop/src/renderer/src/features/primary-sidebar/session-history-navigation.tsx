import type { CSSProperties } from 'react';

import { ArrowLeft, ArrowRight } from 'lucide-react';

import { CommandTooltip } from '../../components/command-tooltip';
import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { navigateSessionHistory } from '../session/session-commands';
import type { SessionNavigationDirection } from '../session/session-navigation-history';
import { useSessionNavigationHistoryStore } from '../session/session-navigation-history';

const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties;

function SessionHistoryButton({ direction }: { direction: SessionNavigationDirection }) {
    const isEnabled = useSessionNavigationHistoryStore((state) =>
        direction === 'back' ? state.canGoBack : state.canGoForward,
    );
    const Icon = direction === 'back' ? ArrowLeft : ArrowRight;
    const { t } = useTranslation();
    return (
        <CommandTooltip
            commandId={direction === 'back' ? 'session.navigateBack' : 'session.navigateForward'}
        >
            <Button
                className="text-muted enabled:hover:text-foreground"
                size="icon"
                variant="ghost"
                aria-label={t(
                    direction === 'back'
                        ? 'primarySidebar.history.back'
                        : 'primarySidebar.history.forward',
                )}
                data-session-history={direction}
                disabled={!isEnabled}
                onClick={() => navigateSessionHistory(direction)}
            >
                <Icon size={14} />
            </Button>
        </CommandTooltip>
    );
}

/**
 * Browser-style Session history controls in the PrimarySidebar header.
 *
 * The header is the window's drag region, so the pair opts out of `-webkit-app-region: drag`; without that the buttons
 * would move the window instead of navigating. They sit immediately after the traffic-light clearance because that is
 * where every browser and Waku, the product this mirrors, put them.
 */
export function SessionHistoryNavigation() {
    return (
        <div className="session-history-navigation flex items-center gap-0.5" style={NO_DRAG}>
            <SessionHistoryButton direction="back" />
            <SessionHistoryButton direction="forward" />
        </div>
    );
}
