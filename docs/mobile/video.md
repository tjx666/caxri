---
kind: living
status: current
---

# Mobile Chat videos

A video that a user message of an Agent Chat cites by its absolute path (`.mp4`, `.m4v`, `.mov`,
`.webm`, `.ogv`, the same set Desktop plays) appears on the phone as a card above the message
bubble: the poster frame, the file name, and a play button. A tap opens a full-screen player with the
platform's own controls for play, pause, and scrubbing; closing it leaves the conversation where it
was. Video upload, videos in Agent replies, and transcoding are out of scope.

## Authorization

Every paired role (`view`, `reply`, `control`) may use both methods: the video is part of a message
the role can already read, and neither method changes anything. Each request names the Terminal, the
user message, and the path. Server Core re-authorizes the device, checks the Project grant and that
the Terminal is a Chat, then serves the path only when `agentChatMessageVideoPaths` returns it for
that message's text. A message missing from the snapshot is searched in up to 20 pages of older
history. The path is then resolved through symlinks and must be a regular file whose resolved name
still has a video extension, so a link to another kind of file is refused.

## Poster

`mobile.video.read` returns `null` when the file is gone, which the card shows as "Video
unavailable" and cannot be opened. Otherwise it returns the poster frame paged in base64 chunks like
`mobile.agentChat.readImage`, so it also reaches the phone over the Relay. Server Core has no
Electron `nativeImage`, so on macOS it draws the frame with `qlmanage -t -s 480` and converts it to
JPEG with `sips`; each command is killed after 15 seconds. Posters are cached by path and
modification time. Elsewhere, or when QuickLook cannot decode the file, `poster` is `null` and the
card keeps its placeholder while the video may still play. The phone asks again each time a card
mounts, keeping the last answer on screen, so reopening a conversation notices a deleted file.

## Playback

`mobile.video.open` returns `http://<gateway address>:<port>/mobile/video/<token>` over the sealed
channel. The listener is separate from the gateway's own, whose per-source connection limit a
seeking player would exhaust, and is shared per gateway address. Every request, `GET` or `HEAD`,
must come from a private peer, carry a token issued less than an hour ago to a device the registry
still authorizes, and still resolve to the same file; it is answered with byte ranges (`206`, or
`416` with `bytes */<size>` past the end) and `Cache-Control: no-store`. A device holds at most eight
tokens, idle listeners close after 15 minutes, and everything closes when mobile access is disabled
or Server Core stops.

The stream is plain HTTP on the LAN address, so the Relay cannot carry it: over the Relay
`mobile.video.open` fails with `UNAVAILABLE` and the player explains that the phone must be on the
same network. Offline, the card stays visible and the player asks to reconnect. A stream that has
started keeps playing over its own connection. A playback failure, such as a codec the phone cannot
decode, shows a message instead of the picture.

## Diagnostics

`mobile_gateway.video_poster` records each poster draw's `outcome` (`drawn`, `unsupported`,
`failed`, `timeout`) and `durationMs`. `mobile_gateway.video_closed` records one listener lifetime:
closed `reason` (`idle`, `cleared`), `durationMs`, `requests`, `rangeRequests`, `bytes` served,
`interrupted` responses, and refused requests by cause. Neither records a path, URL, or content.

## Code

- [Contract](../../packages/protocol/src/mobile/mobile-video-contract.ts) and the shared
  [path scanner and byte ranges](../../packages/protocol/src/agent/agent-chat-path-references.ts)
- [Admission](../../apps/server/src/core/mobile/video/cited-video.ts),
  [poster](../../apps/server/src/core/mobile/video/poster.ts), and
  [stream listener](../../apps/server/src/core/mobile/video/server.ts)
- [Cards and player](../../apps/mobile/src/features/agent-chat/agent-chat-message-videos.tsx)

See [Mobile authorization](authorization.md) for role grants and [Mobile page preview](preview.md)
for the other plain-HTTP side channel.
