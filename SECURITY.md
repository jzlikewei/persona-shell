# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

如果你发现安全漏洞，**请勿在 GitHub Issues 中公开提交**。

请通过以下方式报告：

- 发送邮件至仓库 owner（通过 GitHub profile 获取联系方式）
- 或使用 [GitHub Security Advisories](https://github.com/jzlikewei/persona-shell/security/advisories/new) 私下报告

请在报告中包含：

1. 漏洞描述
2. 复现步骤
3. 影响范围评估
4. 修复建议（如有）

收到报告后我会在 **7 个工作日**内确认并回复。

## 安全注意事项

Persona Shell 运行时会处理以下敏感信息：

- **飞书 App 凭据**：存放在 `~/.persona/config.yaml`，已在 `.gitignore` 中排除
- **Web 控制台**：默认仅监听 `127.0.0.1:3000`，支持 token 认证（`console.token` 配置项）
- **Named Pipe**：IPC 管道创建在 `/tmp/persona/`，依赖操作系统文件权限

部署时请确保：

- `config.yaml` 不被提交到版本控制
- 不要将 Web 控制台端口暴露到公网
- 如需远程访问，请通过 SSH 隧道或 VPN
