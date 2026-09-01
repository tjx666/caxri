import AppKit
import Foundation
import Vision

struct Inspection: Codable {
    let barcodeCount: Int
    let credentialTextKinds: [String]
}

func credentialTextKinds(_ source: String) -> [String] {
    let checks: [(String, String)] = [
        ("pairing-uri", #"caxri\s*:\s*//\s*pair"#),
        ("pairing-secret", #"\b(pairing\s*secret|secret|psk)\s*[:=]"#),
        ("device-credential", #"\b(device\s*credential|credential)\s*[:=]"#),
        ("private-key", #"begin\s+(?:[a-z0-9 -]+\s+)?private\s+key"#),
        ("bearer-token", #"\bbearer\s+[a-z0-9._~+/-]{12,}"#),
    ]
    return checks.compactMap { kind, pattern in
        source.range(of: pattern, options: [.regularExpression, .caseInsensitive]) == nil
            ? nil
            : kind
    }
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("image path is required\n".utf8))
    exit(2)
}

let imagePath = CommandLine.arguments[1]
guard
    let image = NSImage(contentsOfFile: imagePath),
    let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
    FileHandle.standardError.write(Data("image is not decodable\n".utf8))
    exit(2)
}

let barcodeRequest = VNDetectBarcodesRequest()
let textRequest = VNRecognizeTextRequest()
textRequest.recognitionLevel = .accurate
textRequest.usesLanguageCorrection = false

do {
    let handler = VNImageRequestHandler(cgImage: cgImage)
    try handler.perform([barcodeRequest, textRequest])
    let text = (textRequest.results ?? [])
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n")
    let result = Inspection(
        barcodeCount: barcodeRequest.results?.count ?? 0,
        credentialTextKinds: credentialTextKinds(text)
    )
    let data = try JSONEncoder().encode(result)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data("image privacy inspection failed\n".utf8))
    exit(1)
}
