import Foundation
import SwiftUI
import WidgetKit

struct AccountState: Decodable, Sendable {
    let sampledAt: Double?
    let equity: Double
    let equityStale: Bool?
    let cash: Double
    let strategy: String
    let automationEnabled: Bool
    let cpu: Double?
    let memory: Double?
    let petMessage: String?
}

struct AccountEntry: TimelineEntry {
    let date: Date
    let state: AccountState?
    let unavailable: Bool
}

final class LoopbackOnlyDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct AccountProvider: TimelineProvider {
    func placeholder(in context: Context) -> AccountEntry {
        AccountEntry(date: Date(), state: nil, unavailable: false)
    }

    func getSnapshot(in context: Context, completion: @escaping (AccountEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
        } else {
            fetch(completion: completion)
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<AccountEntry>) -> Void) {
        fetch { entry in
            // WidgetKit advances cached entries even when the next fetch is later.
            let refresh = entry.date.addingTimeInterval(15 * 60)
            let expiry = WidgetTiming.transitions(sampledAt: entry.state?.sampledAt, after: entry.date, before: refresh)
            let entries = [entry] + expiry.map { AccountEntry(date: $0, state: entry.state, unavailable: entry.unavailable) }
            completion(Timeline(entries: entries, policy: .after(refresh)))
        }
    }

    private func fetch(completion: @escaping (AccountEntry) -> Void) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 2
        configuration.timeoutIntervalForResource = 2
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.connectionProxyDictionary = [:]
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: LoopbackOnlyDelegate(), delegateQueue: nil)
        let url = URL(string: "http://127.0.0.1:8766/api/widget-state")!
        var request = URLRequest(url: url, timeoutInterval: 2)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        session.dataTask(with: request) { data, response, error in
            defer { session.finishTasksAndInvalidate() }
            guard error == nil, let response = response as? HTTPURLResponse,
                  response.statusCode == 200, response.url?.scheme == "http",
                  response.url?.host == "127.0.0.1", response.url?.port == 8766,
                  response.url?.path == "/api/widget-state", let data, data.count <= 32768,
                  let state = try? JSONDecoder().decode(AccountState.self, from: data),
                  state.equity.isFinite, state.cash.isFinite,
                  state.sampledAt.map({ $0.isFinite && $0 >= 0 }) ?? true,
                  state.cpu.map({ $0.isFinite && (0...100).contains($0) }) ?? true,
                  state.memory.map({ $0.isFinite && (0...100).contains($0) }) ?? true
            else {
                completion(AccountEntry(date: Date(), state: nil, unavailable: true))
                return
            }
            completion(AccountEntry(date: Date(), state: state, unavailable: false))
        }.resume()
    }
}

struct AccountWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: AccountEntry
    private let ink = Color(red: 0.35, green: 0.19, blue: 0.27)
    private let accent = Color(red: 0.76, green: 0.29, blue: 0.46)

    private func percent(_ value: Double?) -> String {
        value.map { String(format: "%.1f%%", $0) } ?? "未采集"
    }
    private var strategy: String {
        guard let state = entry.state else { return "等待账户状态" }
        let name = ["momentum": "追涨止损", "dip": "均值抄底", "dca": "定时投资"][state.strategy] ?? state.strategy
        return "\(name) · \(state.automationEnabled ? "运行" : "暂停")"
    }

    private var samplesFresh: Bool {
        WidgetTiming.isFresh(sampledAt: entry.state?.sampledAt, at: entry.date)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: family == .systemSmall ? 5 : 8) {
            HStack {
                Text("韭留美").font(.headline).foregroundStyle(accent)
                Spacer()
                Image(systemName: "heart.fill").foregroundStyle(accent).accessibilityHidden(true)
            }
            if entry.unavailable {
                Text("服务未运行").font(.title3.bold())
                Text("无法连接本地服务\n点击打开账户面板")
                    .font(.caption).foregroundStyle(ink.opacity(0.8))
                Spacer(minLength: 0)
            } else {
                Text(entry.state?.equityStale == true ? "账户估值 · 行情过期" : samplesFresh ? "账户权益 · 虚拟资金" : "账户快照 · 采样过期/未采集").font(.caption2)
                if let state = entry.state {
                    Text(state.equity, format: .number.precision(.fractionLength(2)))
                        .font(.system(size: family == .systemSmall ? 23 : 29, weight: .semibold, design: .rounded))
                        .monospacedDigit().minimumScaleFactor(0.6).lineLimit(1)
                } else {
                    Text("—").font(.title)
                }
                Text(strategy).font(.caption).lineLimit(1)
                HStack {
                    Text("CPU \(percent(samplesFresh ? entry.state?.cpu : nil))")
                    Spacer(minLength: 4)
                    Text("MEM \(percent(samplesFresh ? entry.state?.memory : nil))")
                }.font(.caption2).monospacedDigit()
                if family == .systemMedium, let message = entry.state?.petMessage, !message.isEmpty {
                    Text(message).font(.caption).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 3) {
                Text("更新")
                if let time = entry.state?.sampledAt {
                    Text(Date(timeIntervalSince1970: time / 1000), style: .time)
                } else {
                    Text("暂无采样")
                }
            }.font(.system(size: 9)).foregroundStyle(ink.opacity(0.7))
        }
        .foregroundStyle(ink)
        .containerBackground(for: .widget) {
            LinearGradient(colors: [Color(red: 1, green: 0.94, blue: 0.96), .white], startPoint: .topLeading, endPoint: .bottomTrailing)
        }
        .widgetURL(URL(string: "jiuliupet://panel"))
    }
}

@main
struct JiuliuWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "local.jiuliu.pet.widget", provider: AccountProvider()) { entry in
            AccountWidgetView(entry: entry)
        }
        .configurationDisplayName("韭留美账户")
        .description("查看账户快照与真实系统指标。刷新由系统调度，点击打开面板。")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
