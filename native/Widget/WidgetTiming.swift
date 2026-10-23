import Foundation

/// Dates are snapshot dates; WidgetKit advances through the supplied timeline.
public enum WidgetTiming {
    public static func isFresh(sampledAt: Double?, at date: Date) -> Bool {
        guard let milliseconds = sampledAt, milliseconds.isFinite, milliseconds >= 0 else { return false }
        let age = date.timeIntervalSince1970 - milliseconds / 1000
        return age.isFinite && age >= -5 && age <= 60
    }

    public static func transitions(sampledAt: Double?, after date: Date, before refresh: Date) -> [Date] {
        guard let milliseconds = sampledAt, milliseconds.isFinite, milliseconds >= 0 else { return [] }
        let sample = milliseconds / 1000
        return [Date(timeIntervalSince1970: sample - 5), Date(timeIntervalSince1970: sample + 60.001)]
            .filter { $0 > date && $0 < refresh }
    }
}
