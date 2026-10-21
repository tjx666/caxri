/**
 * A pasted screenshot is stored inline, as base64, in the same transcript record as the prompt that carried it: Claude
 * Code writes an `image` block whose source is `"data":"<payload>"`, and Codex an `input_image` whose `"image_url"` is
 * a `data:` URL. An image the Agent read with Claude's Read tool is stored twice in its result record: in the `image`
 * block and again as `toolUseResult.file` `"base64":"<payload>"`. Two screenshots already push a short prompt past the
 * readers' per-record ceiling, and discarding the whole record then loses the very request that opened the Session.
 *
 * Base64 payloads never contain a quote, so a run of at least 1 KiB after either prefix can be collapsed even while a
 * record is still being buffered: the remainder that arrives later is collapsed on the next pass. The JSON stays valid
 * because only string contents are removed.
 */
const INLINE_MEDIA_PAYLOAD_PATTERN =
    /("data":"|"base64":"|"image_url":"data:[\w.+-]{1,64}\/[\w.+-]{1,64};base64,)[A-Za-z0-9+/=]{1024,}/gu;

export function compactInlineMediaPayloads(text: string): string {
    return text.replaceAll(INLINE_MEDIA_PAYLOAD_PATTERN, '$1');
}
