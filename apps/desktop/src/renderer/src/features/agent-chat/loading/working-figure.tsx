import './loading.css';

import { BrailleFigure } from './braille-figure';
import { Buddy } from './buddy';
import { CaretFigure } from './caret-figure';
import { DotsFigure } from './dots-figure';
import { OrbitFigure } from './orbit-figure';
import type { WorkingIndicator } from './presentation';
import { isBuddyPartyTurn } from './presentation';

/**
 * The figure that holds a reply's place before anything of it shows, as chosen in `agentChat.workingIndicator`. Nothing
 * has run yet at that point, so Buddy only thinks.
 */
export function WorkingFigure({
    indicator,
    turnId,
}: {
    indicator: WorkingIndicator;
    turnId: string | undefined;
}) {
    switch (indicator) {
        case 'buddy': {
            return <Buddy isParty={isBuddyPartyTurn(turnId)} mood="think" />;
        }
        case 'caret': {
            return <CaretFigure />;
        }
        case 'braille': {
            return <BrailleFigure />;
        }
        case 'orbit': {
            return <OrbitFigure />;
        }
        case 'dots': {
            return <DotsFigure />;
        }
    }
}
