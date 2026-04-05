# TODO

## 待解决

### 服务化：launchd 环境下 PATH 问题
launchd 不加载用户 shell profile（.zshrc/.zprofile），导致 bun、claude 等通过 nvm/homebrew 安装的命令找不到。需要解决 plist 中 PATH 配置的问题，确保所有用户安装的工具在 launchd 环境下可用。

可能的方案：
- plist 中用绝对路径 + 完整 PATH 环境变量
- 写一个 wrapper script 先 source profile 再启动
- 用 `launchctl setenv` 预设环境变量

### Director 编排逻辑
Director 当前是直通管道，需要实现真正的编排：读 state.md、选人格、写 briefing、跑 Solo/Relay/Debate。

### FLUSH 触发逻辑
按消息数/时间/token 阈值自动触发 FLUSH。

### Introspector 定时触发
周度定时启动自省，生成自省报告。

### 日报自动生成
Director 每日自动写日报到 daily/YYYY-MM-DD.md。

### audit_log 写入
记录每个决策的完整链路到 audit_log/。

### Core 层记忆填充
.claude/memory/ 下写入决策模式、品位偏好等 Core 层内容。
