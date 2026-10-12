import type { PullRequestUnavailable } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

/**
 * What the status bar says when the pull request could not be read.
 *
 * Every one of these used to read `PR unknown`, which spent the chip's width on the one word that is true of all eight
 * reasons and useful for none: a missing `gh`, a signed-out CLI, and an exhausted API budget are three different days.
 * The chip names the condition and its hover card keeps the full recovery sentence, so a glance is enough to know
 * whether anything is expected of the user. `other` keeps `unknown` because that is genuinely what it is.
 *
 * `tls` stays separate from `network` even though both mean GitHub is out of reach: the hover card sends one user to
 * check the connection and the other to check a proxy or certificate, and a chip reading `PR offline` would send the
 * second one looking in the wrong place.
 */
export function pullRequestUnavailableLabel(
    reason: PullRequestUnavailable['reason'],
    t: Translate = translate,
): string {
    return t(`statusBar.pullRequest.unavailable.${reason}`);
}
