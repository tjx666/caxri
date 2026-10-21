import { useState } from 'react';

import { domAnimation, LazyMotion } from 'motion/react';
import * as m from 'motion/react-m';

import { useShouldReduceMotion } from '../../../../hooks/use-should-reduce-motion';
import { motionDurationMs, motionEasing } from '../../../../lib/motion';
import { useEnteringKeys } from './use-entering-keys';

/**
 * A work summary's title (`Edited 1 file, ran 3 commands`) as its keyed phrases (`agentChatWorkSummaryPhrases`). A
 * phrase for a kind that joins the summary after it mounted fades in from a slight blur; a count changing inside a
 * phrase, and every phrase present when the Chat opens, stays still.
 */
export function AgentChatWorkSummaryTitle({
    phrases,
}: {
    phrases: ReadonlyArray<{ key: string; text: string }>;
}) {
    const entering = useEnteringKeys(phrases.map(({ key }) => key));
    const isReducedMotion = useShouldReduceMotion();
    return (
        <LazyMotion strict features={domAnimation}>
            <span className="min-w-0 truncate">
                {phrases.map(({ key, text }) => (
                    <SummaryPhrase
                        isEntering={!isReducedMotion && entering.has(key)}
                        key={key}
                        text={text}
                    />
                ))}
            </span>
        </LazyMotion>
    );
}

function SummaryPhrase({ isEntering, text }: { isEntering: boolean; text: string }) {
    // Decided once at mount: the parent marks the key seen right after this commit, and the phrase must keep entering.
    const [entrance] = useState(() =>
        isEntering
            ? {
                  duration: motionDurationMs('--motion-summary-phrase-enter') / 1000,
                  ease: motionEasing('--motion-ease-enter'),
              }
            : undefined,
    );
    if (!entrance) return <m.span>{text}</m.span>;
    return (
        <m.span
            animate={{
                opacity: 1,
                filter: 'blur(0px)',
                // A leftover filter would make the phrase its own stacking context, which the running title's
                // text-clipped highlight sweep cannot paint through.
                transitionEnd: { filter: 'none' },
            }}
            initial={{ opacity: 0, filter: 'blur(4px)' }}
            transition={entrance}
        >
            {text}
        </m.span>
    );
}
