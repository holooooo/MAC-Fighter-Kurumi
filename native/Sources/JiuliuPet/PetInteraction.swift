import Foundation
import CoreGraphics

/// Pointer coordinates are already converted to screen points by the AppKit view.
/// This value type never reads or sends system events and never writes preferences.
struct PetPressSession {
    let initialMouse: CGPoint
    let initialFrame: CGRect
    let pressedAt: TimeInterval
    private(set) var maximumMovement: CGFloat = 0
    private(set) var dragging = false

    mutating func update(mouse: CGPoint) -> (started: Bool, frame: CGRect?) {
        let dx = mouse.x - initialMouse.x, dy = mouse.y - initialMouse.y
        guard dx.isFinite, dy.isFinite else { return (false, nil) }
        maximumMovement = max(maximumMovement, hypot(dx, dy))
        let started = !dragging && maximumMovement >= 4
        if started { dragging = true }
        let frame = dragging ? CGRect(origin: CGPoint(x: initialFrame.minX + dx, y: initialFrame.minY + dy), size: initialFrame.size) : nil
        return (started, frame)
    }

    func isTap(releasedAt: TimeInterval) -> Bool {
        let duration = releasedAt - pressedAt
        return !dragging && maximumMovement < 4 && duration.isFinite && (0...1).contains(duration)
    }
}

enum PetWindowGeometry {
    static func clamp(_ frame: CGRect, to availableScreens: [CGRect]) -> CGRect {
        let screens = availableScreens.filter { !$0.isNull && $0.width > 0 && $0.height > 0 && [$0.minX, $0.minY, $0.width, $0.height].allSatisfy(\.isFinite) }
        guard !screens.isEmpty, [frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite), frame.width > 0, frame.height > 0 else { return frame }
        func overlap(_ screen: CGRect) -> CGFloat {
            let intersection = frame.intersection(screen)
            return intersection.isNull ? 0 : intersection.width * intersection.height
        }
        func distance(_ screen: CGRect) -> CGFloat {
            let dx = max(screen.minX - frame.midX, 0, frame.midX - screen.maxX)
            let dy = max(screen.minY - frame.midY, 0, frame.midY - screen.maxY)
            return dx * dx + dy * dy
        }
        let screen = screens.sorted {
            let a = overlap($0), b = overlap($1)
            return a == b ? distance($0) < distance($1) : a > b
        }[0]
        let size = CGSize(width: min(frame.width, screen.width), height: min(frame.height, screen.height))
        return CGRect(x: min(max(frame.minX, screen.minX), screen.maxX - size.width),
                      y: min(max(frame.minY, screen.minY), screen.maxY - size.height),
                      width: size.width, height: size.height)
    }
}
