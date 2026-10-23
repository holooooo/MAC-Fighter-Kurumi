import Foundation
import CoreGraphics

struct RegressionFailure: Error, CustomStringConvertible {
    let description: String
}
func require(_ condition: @autoclosure () -> Bool, _ message: String = "Condition failed") throws {
    if !condition() { throw RegressionFailure(description: message) }
}
func equal<T: Equatable>(_ actual: T, _ expected: T, _ message: String = "Values differ") throws {
    if actual != expected { throw RegressionFailure(description: "\(message): \(actual) != \(expected)") }
}

enum PetInteractionTests {
    static func run() throws -> [String] {
        let frame = CGRect(x: 50, y: 100, width: 330, height: 440)
        var press = PetPressSession(initialMouse: CGPoint(x: 200, y: 300), initialFrame: frame, pressedAt: 10)
        try require(press.update(mouse: CGPoint(x: 202, y: 302)).frame == nil)
        try require(press.isTap(releasedAt: 10.8))
        try require(!press.isTap(releasedAt: 11.01) && !press.isTap(releasedAt: 9.9) && !press.isTap(releasedAt: .nan))

        press = PetPressSession(initialMouse: CGPoint(x: 200, y: 300), initialFrame: frame, pressedAt: 10)
        try require(!press.update(mouse: CGPoint(x: 203.9, y: 300)).started)
        let crossing = press.update(mouse: CGPoint(x: 204, y: 300))
        try require(crossing.started)
        try equal(crossing.frame?.origin, CGPoint(x: 54, y: 100))
        try require(!press.update(mouse: CGPoint(x: 200, y: 300)).started)
        try require(press.dragging && !press.isTap(releasedAt: 10.5))

        press = PetPressSession(initialMouse: CGPoint(x: 200, y: 300), initialFrame: frame, pressedAt: 10)
        try equal(press.update(mouse: CGPoint(x: 220, y: 320)).frame?.origin, CGPoint(x: 70, y: 120))
        try equal(press.update(mouse: CGPoint(x: 235, y: 310)).frame?.origin, CGPoint(x: 85, y: 110))
        try equal(press.update(mouse: CGPoint(x: 235, y: 310)).frame?.origin, CGPoint(x: 85, y: 110))
        try require(press.update(mouse: CGPoint(x: CGFloat.nan, y: 0)).frame == nil)

        let visible = CGRect(x: 0, y: 25, width: 1440, height: 850)
        let restored = PetWindowGeometry.clamp(CGRect(x: 3000, y: -150, width: 330, height: 440), to: [visible])
        try equal(restored, CGRect(x: 1110, y: 25, width: 330, height: 440))
        try require(visible.contains(restored))

        let left = CGRect(x: -1280, y: 0, width: 1280, height: 800)
        let onLeft = CGRect(x: -1000, y: 100, width: 330, height: 440)
        try equal(PetWindowGeometry.clamp(onLeft, to: [visible, left]), onLeft)
        try equal(PetWindowGeometry.clamp(CGRect(x: -2000, y: -100, width: 2000, height: 1000), to: [left]), left)
        try equal(PetWindowGeometry.clamp(frame, to: []), frame)
        let small = CGRect(x: 0, y: 0, width: 300, height: 400)
        try equal(PetWindowGeometry.clamp(frame, to: [small]).size, small.size)
        return ["tap jitter and long/reversed time", "drag threshold and return-to-origin", "absolute screen coordinates without drift", "removed display restoration", "negative/undersized display clamp"]
    }
}
