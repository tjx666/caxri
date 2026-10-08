/**
 * Reading acceptance report links out of free text, shared by the two places that find them: the Agent transcript
 * scanner and the pull request body reader. One owner, because a link that the status bar recognizes in a conversation
 * and ignores in a pull request body (or the reverse) is a bug the user experiences as randomness.
 *
 * `app.lobehub.com` is a public host and `@lobehub/cli` is a public npm package, so naming both is the same kind of
 * first-party integration as the `linear.app` reader, not an internal address.
 */

/**
 * One acceptance report some text linked to. Unlike a Linear marker there is no bare form to guess at: an acceptance is
 * addressed by an opaque id, so only a full URL can name one and no allow-list has to rule on it.
 */
export interface AcceptanceReference {
    id: string;
    /**
     * The verification round the link pinned, when its query string named one. Absent means the link pointed at the
     * report as a whole.
     */
    round?: number;
}

const ACCEPTANCE_BASE_URL = 'https://app.lobehub.com/acceptance';

/**
 * The id is spelled as a full UUID rather than a loose character run so a neighbouring word can never be absorbed into
 * it, and the optional `/check/<id>` tail is consumed so a deep link into one check still resolves to the report that
 * owns it. The query run is length-capped: the pattern is run over Agent output, where an unbounded tail is somebody
 * else's paste, not a link.
 */
const ACCEPTANCE_URL_PATTERN =
    /https?:\/\/app\.lobehub\.com\/acceptance\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})(?:\/check\/[\w-]+)?(\?[\w%&+.=-]{0,256})?/gi;
/**
 * `turn` is the parameter the viewer keeps; `r` is the short form a shared link still carries, which the viewer
 * rewrites to `turn` on load. Both have to be read, because a link is usually pasted exactly as it was copied.
 */
const ACCEPTANCE_ROUND_PATTERN = /[?&](?:turn|r)=([1-9]\d{0,3})(?![\d.])/i;

/**
 * Rebuilds the link from the id rather than echoing the matched text, so a URL Caxri hands the user is a shape Caxri
 * chose: a decorated or redirect-laden paste cannot travel into the status bar as a clickable destination.
 */
export function acceptanceUrl(id: string, round?: number): string {
    return round ? `${ACCEPTANCE_BASE_URL}/${id}?turn=${round}` : `${ACCEPTANCE_BASE_URL}/${id}`;
}

/**
 * Every acceptance link in `text`, in the order it appears, ids lower-cased. Duplicates are left in: the two callers
 * disagree on what a repeat means: a transcript treats it as "most recent wins", a pull request body as "already seen",
 * so collapsing here would take that decision away from both.
 */
export function findAcceptanceLinks(text: string): AcceptanceReference[] {
    const references: AcceptanceReference[] = [];
    for (const match of text.matchAll(ACCEPTANCE_URL_PATTERN)) {
        const round = match[2] ? ACCEPTANCE_ROUND_PATTERN.exec(match[2]) : null;
        references.push({
            id: match[1].toLowerCase(),
            ...(round && { round: Number(round[1]) }),
        });
    }
    return references;
}
