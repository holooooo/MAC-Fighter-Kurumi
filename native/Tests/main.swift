import Foundation

do {
    let cases = try PetInteractionTests.run() + WidgetTimingTests.run()
    let report: [String: Any] = ["passed": true, "caseCount": cases.count, "cases": cases, "scope": "Pure Swift state/geometry/timeline, no OS events, service or preferences"]
    let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    print(String(data: data, encoding: .utf8)!)
} catch {
    fputs("Native regression failed: \(error)\n", stderr)
    exit(1)
}
