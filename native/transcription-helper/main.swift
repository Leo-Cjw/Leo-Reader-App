import AVFoundation
import CoreMedia
import Foundation
import whisper

private struct Request: Decodable {
    let version: Int
    let operation: String
    let mediaPath: String
    let modelPath: String
    let language: String
}

private struct Segment: Encodable {
    let startMs: Int64
    let endMs: Int64
    let text: String
}

private struct Response: Encodable {
    let version: Int
    let segments: [Segment]
}

private enum HelperError: LocalizedError {
    case invalidRequest
    case invalidFile
    case audioTrackMissing
    case decodeFailed
    case modelFailed
    case transcriptionFailed

    var errorDescription: String? {
        switch self {
        case .invalidRequest: return "转写请求无效"
        case .invalidFile: return "转写文件无效"
        case .audioTrackMissing: return "媒体没有可解码的音轨"
        case .decodeFailed: return "AVFoundation 无法解码媒体"
        case .modelFailed: return "Whisper 模型无法加载"
        case .transcriptionFailed: return "Whisper 本地转写失败"
        }
    }
}

private func regularFile(_ path: String) throws -> URL {
    guard path.utf8.count <= 4096 else { throw HelperError.invalidFile }
    let url = URL(fileURLWithPath: path).standardizedFileURL
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? 0) > 0 else {
        throw HelperError.invalidFile
    }
    return url
}

private func decodeAudio(_ url: URL) async throws -> [Float] {
    let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
    guard let track = try await asset.loadTracks(withMediaType: .audio).first else { throw HelperError.audioTrackMissing }
    let reader = try AVAssetReader(asset: asset)
    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 16_000,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 32,
        AVLinearPCMIsFloatKey: true,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false
    ]
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { throw HelperError.decodeFailed }
    reader.add(output)
    guard reader.startReading() else { throw reader.error ?? HelperError.decodeFailed }
    var samples: [Float] = []
    while let sampleBuffer = output.copyNextSampleBuffer() {
        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { continue }
        let length = CMBlockBufferGetDataLength(block)
        if length <= 0 { continue }
        var bytes = [UInt8](repeating: 0, count: length)
        guard CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: &bytes) == kCMBlockBufferNoErr else {
            throw HelperError.decodeFailed
        }
        bytes.withUnsafeBytes { raw in
            samples.append(contentsOf: raw.bindMemory(to: Float.self))
        }
    }
    guard reader.status == .completed, !samples.isEmpty else { throw reader.error ?? HelperError.decodeFailed }
    return samples
}

private func transcribe(_ samples: [Float], modelURL: URL, language: String) throws -> [Segment] {
    var contextParameters = whisper_context_default_params()
    contextParameters.use_gpu = true
    guard let context = modelURL.path.withCString({ whisper_init_from_file_with_params($0, contextParameters) }) else {
        throw HelperError.modelFailed
    }
    defer { whisper_free(context) }
    var parameters = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
    parameters.print_realtime = false
    parameters.print_progress = false
    parameters.print_timestamps = false
    parameters.print_special = false
    parameters.translate = false
    parameters.no_context = true
    parameters.single_segment = false
    parameters.n_threads = Int32(max(1, min(ProcessInfo.processInfo.activeProcessorCount - 1, 8)))
    let result = language.withCString { languagePointer -> Int32 in
        parameters.language = languagePointer
        return samples.withUnsafeBufferPointer { buffer in
            whisper_full(context, parameters, buffer.baseAddress, Int32(buffer.count))
        }
    }
    guard result == 0 else { throw HelperError.transcriptionFailed }
    let count = whisper_full_n_segments(context)
    return (0..<count).compactMap { index in
        guard let textPointer = whisper_full_get_segment_text(context, index) else { return nil }
        let text = String(cString: textPointer).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return Segment(
            startMs: whisper_full_get_segment_t0(context, index) * 10,
            endMs: whisper_full_get_segment_t1(context, index) * 10,
            text: text
        )
    }
}

do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count > 0, input.count <= 32 * 1024 else { throw HelperError.invalidRequest }
    let request = try JSONDecoder().decode(Request.self, from: input)
    guard request.version == 1, request.operation == "transcribe",
          request.language == "auto" || request.language.range(of: #"^[a-z]{2,3}(?:-[A-Z]{2})?$"#, options: .regularExpression) != nil else {
        throw HelperError.invalidRequest
    }
    let mediaURL = try regularFile(request.mediaPath)
    let modelURL = try regularFile(request.modelPath)
    let samples = try await decodeAudio(mediaURL)
    let segments = try transcribe(samples, modelURL: modelURL, language: request.language)
    let encoded = try JSONEncoder().encode(Response(version: 1, segments: segments))
    FileHandle.standardOutput.write(encoded)
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
    exit(1)
}
