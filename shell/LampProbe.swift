/**
 * 托盘灯色判定 —— 从 AppDelegate 里抽出来，单独可测（shell/lamp-test.swift）。
 * 规则：所有服务里最差的一档胜出：red > amber > 其他（unknown 不压低绿灯）。
 */
import Foundation

/// 解析 /api/state 的 JSON，返回最差灯色："red" | "amber" | "green"
func worstLamp(fromStateJSON data: Data) -> String {
    guard let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let services = j["services"] as? [[String: Any]] else {
        return "green" // 拿不到状态不吓人（面板自己会显示连接失败）
    }
    var worst = "green"
    for s in services {
        switch s["lamp"] as? String ?? "unknown" {
        case "red": return "red" // 已经最差，无需继续
        case "amber": worst = "amber"
        default: break // green / unknown：不压低
        }
    }
    return worst
}
