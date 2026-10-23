import Foundation

enum WidgetTimingTests {
    static func run() throws -> [String] {
        let now = Date(timeIntervalSince1970: 1000)
        let refresh = now.addingTimeInterval(900)
        try require(WidgetTiming.isFresh(sampledAt: 1_000_000, at: now))
        try require(WidgetTiming.isFresh(sampledAt: 940_000, at: now))
        try require(!WidgetTiming.isFresh(sampledAt: 939_999, at: now))
        try require(WidgetTiming.isFresh(sampledAt: 1_005_000, at: now))
        try require(!WidgetTiming.isFresh(sampledAt: 1_005_001, at: now))
        for invalid in [Double.nan, .infinity, -1] {
            try require(!WidgetTiming.isFresh(sampledAt: invalid, at: now))
            try require(WidgetTiming.transitions(sampledAt: invalid, after: now, before: refresh).isEmpty)
        }
        try require(!WidgetTiming.isFresh(sampledAt: nil, at: now))
        try require(WidgetTiming.transitions(sampledAt: nil, after: now, before: refresh).isEmpty)

        let freshDates = WidgetTiming.transitions(sampledAt: 1_000_000, after: now, before: refresh)
        try equal(freshDates.count, 1)
        try require(freshDates[0] > now && freshDates[0] < refresh)
        try require(!WidgetTiming.isFresh(sampledAt: 1_000_000, at: freshDates[0]), "Cached snapshot must become stale before next network fetch")
        try require(WidgetTiming.transitions(sampledAt: 900_000, after: now, before: refresh).isEmpty)
        let future = WidgetTiming.transitions(sampledAt: 1_010_000, after: now, before: refresh)
        try equal(future.count, 2)
        try require(future[0] < future[1])
        try require(WidgetTiming.isFresh(sampledAt: 1_010_000, at: future[0]))
        try require(!WidgetTiming.isFresh(sampledAt: 1_010_000, at: future[1]))
        try require(WidgetTiming.transitions(sampledAt: 5_000_000, after: now, before: refresh).isEmpty)
        return ["freshness exact boundaries", "missing/invalid timestamp", "cached expiry before fifteen-minute fetch", "stale snapshots and future clock tolerance"]
    }
}
