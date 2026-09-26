/**
 * 托盘灯色判定单测（P2-3 验证）：`bash shell/lamp-test.sh`
 * 用真实 /api/state 形状的样例 JSON 断言最差档取值。
 */
import Foundation

func check(_ name: String, _ got: String, _ want: String, _ failed: inout Int) {
    let ok = got == want
    if !ok { failed += 1 }
    print("\(ok ? "✔" : "✘") \(name): got=\(got) want=\(want)")
}

func state(_ lamps: [String]) -> Data {
    let svcs = lamps.map { "{\"id\":\"s\",\"lamp\":\"\($0)\"}" }.joined(separator: ",")
    return Data("{\"services\":[\(svcs)]}".utf8)
}

@main
struct LampTest {
    static func main() {
        var failed = 0
        check("全绿", worstLamp(fromStateJSON: state(["green", "green"])), "green", &failed)
        check("含 amber", worstLamp(fromStateJSON: state(["green", "amber"])), "amber", &failed)
        check("含 red", worstLamp(fromStateJSON: state(["green", "amber", "red"])), "red", &failed)
        check("red 在首位", worstLamp(fromStateJSON: state(["red", "green"])), "red", &failed)
        check("unknown 不压低", worstLamp(fromStateJSON: state(["unknown", "green"])), "green", &failed)
        // grey（已停止：plist 在但未 launchctl load）不是故障，不能像红灯一样刺眼
        check("grey 不压低绿", worstLamp(fromStateJSON: state(["grey", "green"])), "green", &failed)
        check("grey 混 amber 仍取 amber", worstLamp(fromStateJSON: state(["grey", "amber"])), "amber", &failed)
        check("red 优先于 grey", worstLamp(fromStateJSON: state(["grey", "red"])), "red", &failed)
        check("全 grey 不报警", worstLamp(fromStateJSON: state(["grey", "grey"])), "green", &failed)
        check("空服务列表", worstLamp(fromStateJSON: state([])), "green", &failed)
        check("坏 JSON", worstLamp(fromStateJSON: Data("not json".utf8)), "green", &failed)
        check("缺 services 字段", worstLamp(fromStateJSON: Data("{\"engines\":[]}".utf8)), "green", &failed)
        print(failed == 0 ? "\n全部通过" : "\n\(failed) 项失败")
        exit(failed == 0 ? 0 : 1)
    }
}
