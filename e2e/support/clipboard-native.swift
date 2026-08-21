import AppKit
import Darwin
import Foundation

private struct PasteboardEntry: Codable, Equatable {
    let data: Data
    let type: String
}

private struct PasteboardItemRecord: Codable, Equatable {
    let entries: [PasteboardEntry]
}

private struct PasteboardSnapshotPayload: Codable, Equatable {
    let items: [PasteboardItemRecord]
}

private struct SnapshotResponse: Encodable {
    let formatCount: Int
    let generation: Int
    let itemCount: Int
    let payload: String
}

private struct MetadataResponse: Encodable {
    let formatCount: Int
    let generation: Int
    let itemCount: Int
}

private struct GenerationResponse: Encodable {
    let generation: Int
}

private struct MatchResponse: Encodable {
    let matches: Bool
}

private struct RestoreRequest: Decodable {
    let expectedGeneration: Int
    let payload: String
}

private struct SnapshotRequest: Decodable {
    let payload: String
}

private struct TextClaimRequest: Decodable {
    let text: String
}

private struct RestoreResponse: Encodable {
    let generation: Int
    let status: String
}

private enum PasteboardFailure: Error {
    case invalidInput
    case missingAdvertisedData
    case writeFailed
}

private let encoder = JSONEncoder()
private let decoder = JSONDecoder()
private let pasteboard = NSPasteboard.general
private let maxEncodedPayloadBytes = 48 * 1024 * 1024
private let maxFormatCount = 2_048
private let maxInputBytes = 64 * 1024 * 1024
private let maxItemCount = 256
private let maxPayloadBytes = 32 * 1024 * 1024

private func readInput<T: Decodable>(_ type: T.Type) throws -> T {
    var data = Data()
    while true {
        let chunk = try FileHandle.standardInput.read(upToCount: 64 * 1024) ?? Data()
        if chunk.isEmpty { break }
        guard data.count <= maxInputBytes - chunk.count else {
            throw PasteboardFailure.invalidInput
        }
        data.append(chunk)
    }
    guard !data.isEmpty else { throw PasteboardFailure.invalidInput }
    return try decoder.decode(type, from: data)
}

private func writeOutput<T: Encodable>(_ value: T) throws {
    FileHandle.standardOutput.write(try encoder.encode(value))
}

private func capturePayload() throws -> PasteboardSnapshotPayload {
    let pasteboardItems = pasteboard.pasteboardItems ?? []
    guard pasteboardItems.count <= maxItemCount else { throw PasteboardFailure.invalidInput }
    var formatCount = 0
    var payloadBytes = 0
    var items: [PasteboardItemRecord] = []
    items.reserveCapacity(pasteboardItems.count)
    for item in pasteboardItems {
        var entries: [PasteboardEntry] = []
        for type in item.types.sorted(by: { $0.rawValue < $1.rawValue }) {
            formatCount += 1
            guard formatCount <= maxFormatCount,
                  let data = item.data(forType: type),
                  data.count <= maxPayloadBytes - payloadBytes else {
                throw PasteboardFailure.missingAdvertisedData
            }
            payloadBytes += data.count
            entries.append(PasteboardEntry(data: data, type: type.rawValue))
        }
        items.append(PasteboardItemRecord(entries: entries))
    }
    return PasteboardSnapshotPayload(items: items)
}

private func captureStablePayload() throws -> (payload: PasteboardSnapshotPayload, generation: Int) {
    let generationBeforeRead = pasteboard.changeCount
    let payload = try capturePayload()
    let generationAfterRead = pasteboard.changeCount
    guard generationBeforeRead == generationAfterRead else {
        throw PasteboardFailure.invalidInput
    }
    return (payload, generationAfterRead)
}

private func decodePayload(_ encodedPayload: String) throws -> PasteboardSnapshotPayload {
    guard let data = Data(base64Encoded: encodedPayload), data.count <= maxEncodedPayloadBytes else {
        throw PasteboardFailure.invalidInput
    }
    let payload = try decoder.decode(PasteboardSnapshotPayload.self, from: data)
    try validatePayload(payload)
    return payload
}

private func encodePayload(_ payload: PasteboardSnapshotPayload) throws -> String {
    try encoder.encode(payload).base64EncodedString()
}

private func formatCount(_ payload: PasteboardSnapshotPayload) -> Int {
    payload.items.reduce(0) { count, item in count + item.entries.count }
}

private func validatePayload(_ payload: PasteboardSnapshotPayload) throws {
    guard payload.items.count <= maxItemCount else { throw PasteboardFailure.invalidInput }
    var formats = 0
    var payloadBytes = 0
    for item in payload.items {
        formats += item.entries.count
        guard formats <= maxFormatCount else { throw PasteboardFailure.invalidInput }
        for entry in item.entries {
            guard entry.data.count <= maxPayloadBytes - payloadBytes else {
                throw PasteboardFailure.invalidInput
            }
            payloadBytes += entry.data.count
        }
    }
}

private func metadata(
    for payload: PasteboardSnapshotPayload,
    generation: Int
) -> MetadataResponse {
    MetadataResponse(
        formatCount: formatCount(payload),
        generation: generation,
        itemCount: payload.items.count
    )
}

private func makePasteboardItems(_ payload: PasteboardSnapshotPayload) throws -> [NSPasteboardItem] {
    try validatePayload(payload)
    return payload.items.map { itemRecord in
        let item = NSPasteboardItem()
        for entry in itemRecord.entries {
            item.setData(entry.data, forType: NSPasteboard.PasteboardType(entry.type))
        }
        return item
    }
}

private func replacePasteboardContents(with items: [NSPasteboardItem]) throws {
    pasteboard.clearContents()
    if !items.isEmpty && !pasteboard.writeObjects(items) {
        throw PasteboardFailure.writeFailed
    }
}

private func writePayload(_ payload: PasteboardSnapshotPayload) throws {
    try replacePasteboardContents(with: makePasteboardItems(payload))
}

private func fixture(_ name: String) throws -> PasteboardSnapshotPayload {
    switch name {
    case "custom-formats":
        return PasteboardSnapshotPayload(items: [
            PasteboardItemRecord(entries: [
                PasteboardEntry(data: Data([0x00, 0x01, 0xCA, 0x58]), type: "com.caxri.e2e.custom-a"),
                PasteboardEntry(data: Data([0x10, 0x20, 0x30]), type: "com.caxri.e2e.custom-b"),
            ]),
            PasteboardItemRecord(entries: [
                PasteboardEntry(data: Data([0x40, 0x50]), type: "com.caxri.e2e.custom-c"),
                PasteboardEntry(data: Data([0x60, 0x70, 0x80, 0x90]), type: "com.caxri.e2e.custom-d"),
            ]),
        ])
    case "external-write":
        return PasteboardSnapshotPayload(items: [
            PasteboardItemRecord(entries: [
                PasteboardEntry(data: Data([0xEE, 0x58, 0x54]), type: "com.caxri.e2e.external"),
            ]),
        ])
    default:
        throw PasteboardFailure.invalidInput
    }
}

private func fixtureName(for command: String, prefix: String) throws -> String {
    guard command.hasPrefix(prefix) else { throw PasteboardFailure.invalidInput }
    let name = String(command.dropFirst(prefix.count))
    guard name == "custom-formats" || name == "external-write" else {
        throw PasteboardFailure.invalidInput
    }
    return name
}

do {
    guard CommandLine.arguments.count == 2 else { throw PasteboardFailure.invalidInput }
    let command = CommandLine.arguments[1]
    switch command {
    case "claim-image":
        let generationBeforeRead = pasteboard.changeCount
        let image = NSImage(pasteboard: pasteboard)
        let generationAfterRead = pasteboard.changeCount
        guard image != nil && generationBeforeRead == generationAfterRead else {
            throw PasteboardFailure.invalidInput
        }
        try writeOutput(GenerationResponse(generation: generationAfterRead))
    case "claim-text":
        let request = try readInput(TextClaimRequest.self)
        let generationBeforeRead = pasteboard.changeCount
        let text = pasteboard.string(forType: .string)
        let generationAfterRead = pasteboard.changeCount
        guard text == request.text && generationBeforeRead == generationAfterRead else {
            throw PasteboardFailure.invalidInput
        }
        try writeOutput(GenerationResponse(generation: generationAfterRead))
    case "snapshot":
        let snapshot = try captureStablePayload()
        try writeOutput(SnapshotResponse(
            formatCount: formatCount(snapshot.payload),
            generation: snapshot.generation,
            itemCount: snapshot.payload.items.count,
            payload: try encodePayload(snapshot.payload)
        ))
    case "restore":
        let request = try readInput(RestoreRequest.self)
        let expected = try decodePayload(request.payload)
        let expectedItems = try makePasteboardItems(expected)
        // Decode and construct every item before the last possible ownership check. NSPasteboard has no atomic
        // compare-and-swap; the shared desktop lease serializes harness writers while this check prevents overwriting
        // an external generation already visible when restoration begins.
        if pasteboard.changeCount != request.expectedGeneration {
            try writeOutput(RestoreResponse(
                generation: pasteboard.changeCount,
                status: "skipped-external-write"
            ))
        } else {
            try replacePasteboardContents(with: expectedItems)
            let restored = try captureStablePayload()
            guard restored.payload == expected else { throw PasteboardFailure.writeFailed }
            try writeOutput(RestoreResponse(
                generation: restored.generation,
                status: "restored"
            ))
        }
    case "matches-snapshot":
        let request = try readInput(SnapshotRequest.self)
        let snapshot = try captureStablePayload()
        try writeOutput(MatchResponse(
            matches: snapshot.payload == decodePayload(request.payload)
        ))
    default:
        if command.hasPrefix("write-") {
            let payload = try fixture(try fixtureName(for: command, prefix: "write-"))
            try writePayload(payload)
            let written = try captureStablePayload()
            guard written.payload == payload else { throw PasteboardFailure.writeFailed }
            try writeOutput(metadata(for: written.payload, generation: written.generation))
        } else if command.hasPrefix("matches-") {
            let expected = try fixture(try fixtureName(for: command, prefix: "matches-"))
            try writeOutput(MatchResponse(matches: try captureStablePayload().payload == expected))
        } else {
            throw PasteboardFailure.invalidInput
        }
    }
} catch {
    // Clipboard contents and native error details must never cross into logs or test artifacts.
    exit(1)
}
