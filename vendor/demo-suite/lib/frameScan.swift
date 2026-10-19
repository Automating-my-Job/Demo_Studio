// frameScan.swift — reads the text in every image of a folder with macOS
// Vision (on-device; nothing leaves the machine) and prints
// {"file.png": ["line", ...], ...} as JSON on stdout. Built and cached by
// frameScan.js; never run it on its own against a published folder.
import AppKit
import Foundation
import Vision

let dir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? [])
  .filter { $0.hasSuffix(".png") || $0.hasSuffix(".jpg") }
  .sorted()
var out: [String: [String]] = [:]
for name in files {
  let path = (dir as NSString).appendingPathComponent(name)
  guard let image = NSImage(contentsOfFile: path),
        let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    out[name] = []
    continue
  }
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  // Keep ids and addresses as drawn; language correction "fixes" them.
  request.usesLanguageCorrection = false
  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
  out[name] = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
}
let data = try JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(data)
