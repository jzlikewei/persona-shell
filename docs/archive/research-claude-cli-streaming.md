# Claude Code CLI 编程接口调研

## 双向 stream-json 通信

Claude Code CLI 原生支持通过 stdin/stdout 进行结构化双向通信，可作为长驻子进程运行。

### 启动命令

```bash
claude --print \
  --input-format stream-json \
  --output-format stream-json \
  --verbose
```

### 输入协议（写 stdin）

每行一个 JSON 对象：

```json
{"type":"user","message":{"role":"user","content":"你的消息"}}
```

### 输出协议（读 stdout）

每行一个 JSON 对象，按 `type` 字段区分：

| type | subtype | 说明 |
|------|---------|------|
| `system` | `init` | 初始化信息：工具列表、session_id、模型等 |
| `assistant` | - | 助手回复（分 thinking 和 text 两个 chunk） |
| `result` | `success` | 本轮结果：cost、usage、duration 等 |

### 多轮会话

- 连续发送多条消息，进程正确处理多轮对话
- 共享同一个 `session_id`
- 第二条消息自动带上前一轮上下文（有状态会话）

### 配套标志

| 标志 | 说明 |
|------|------|
| `--input-format <format>` | 输入格式：`text`（默认）或 `stream-json` |
| `--output-format <format>` | 输出格式：`text`、`json`、`stream-json` |
| `--verbose` | `stream-json` 输出模式必须搭配此标志 |
| `--replay-user-messages` | 在 stdout 回显用户消息（仅双向 stream-json 时有效） |
| `--bare` | 跳过 hooks、LSP、插件等，最小化启动 |
| `--no-session-persistence` | 不保存会话到磁盘 |
| `--max-budget-usd <amount>` | 限制 API 花费 |
| `--include-partial-messages` | 包含部分消息（token 级流式） |
| `--include-hook-events` | 包含 hook 生命周期事件 |
| `--dangerously-skip-permissions` | 跳过权限检查（仅沙盒环境） |

### TS Shell 集成示例

```typescript
import { spawn } from 'child_process';

const director = spawn('claude', [
  '--print',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose'
]);

// 发送消息
function send(msg: string) {
  director.stdin.write(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: msg }
  }) + '\n');
}

// 接收回复
director.stdout.on('data', (chunk) => {
  const lines = chunk.toString().split('\n').filter(Boolean);
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.type === 'assistant') {
      // 提取回复内容，发回飞书
    }
  }
});
```

## 结论

Claude Code CLI 完全支持作为长驻子进程运行，通过 stdin/stdout 双向 stream-json 进行结构化通信。TS Shell 只需做飞书协议与 stream-json 之间的格式转换。
