# 远程访问 Web 控制台

将 Persona Shell 的 Web 控制台通过 HTTPS 暴露到公网，适用于需要在外部网络访问家中/内网机器的场景。

## 架构

```
浏览器 ──HTTPS──▶ 公网服务器 (Nginx + SSL) ──反向代理──▶ SSH 隧道 ──▶ 本地机器 (pshell :3000)
```

核心思路：本地机器主动建一条 SSH 反向隧道到公网服务器，Nginx 在公网端做 TLS 终止和反向代理。对 Web 控制台前端完全透明。

## 前置条件

- 一台公网服务器（有固定 IP 或域名）
- 域名 DNS 已指向公网服务器 IP
- 公网服务器可 SSH 登录（`ssh user@your-server`）
- 本地机器可 SSH 到公网服务器（免密钥认证推荐）

## 第一步：公网服务器安装 Nginx + Certbot

```bash
ssh user@your-server

# Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y nginx certbot python3-certbot-nginx
```

## 第二步：申请 SSL 证书

```bash
sudo certbot --nginx -d your-domain.com --non-interactive --agree-tos --email your@email.com
```

Certbot 会自动配置 Let's Encrypt 证书并设置自动续期。

## 第三步：配置 Nginx 反向代理

选一个公网端口（示例用 14242），编辑 Nginx 配置：

```bash
sudo tee /etc/nginx/sites-enabled/pshell-remote << 'EOF'
server {
    listen 14242 ssl;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # Basic Auth（推荐，防止裸露到公网）
    auth_basic "pshell";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:13000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
EOF
```

创建 Basic Auth 密码文件：

```bash
# 用户名 pshell，密码替换为你的 token
echo 'your-token' | sudo htpasswd -ci /etc/nginx/.htpasswd pshell
```

测试并重载：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

> **端口说明**：Nginx 监听 14242（公网端口），反向代理到 13000（隧道端口）。不用 3000 是因为公网服务器上可能已有服务占用 3000。

## 第四步：配置 pshell 内置 Token 认证

编辑 `~/.persona/config.yaml`：

```yaml
console:
  enabled: true
  port: 3000
  token: "your-secret-token"    # 配置后 HTTP API 和 WebSocket 需携带 token
```

修改 config.yaml 后需要重启 Shell 才能生效。pshell 内置认证支持两种方式：
- HTTP API：`Authorization: Bearer <token>`
- WebSocket：`?token=<token>` query param

> 这是第二层认证。Nginx Basic Auth 是第一层，pshell token 是第二层。两层独立，建议都开启。

## 第五步：建立 SSH 反向隧道

### 方式 A：手动（测试用）

```bash
ssh -N -R 13000:localhost:3000 user@your-server
```

`-N` 不开 shell，`-R` 将本地 3000 映射到服务器 13000。

### 方式 B：autossh + launchd（生产推荐）

安装 autossh（macOS）：

```bash
brew install autossh
```

创建 launchd plist `~/Library/LaunchAgents/com.persona.tunnel.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.persona.tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/autossh</string>
        <string>-M</string>
        <string>0</string>
        <string>-N</string>
        <string>-o</string>
        <string>ServerAliveInterval=30</string>
        <string>-o</string>
        <string>ServerAliveCountMax=3</string>
        <string>-o</string>
        <string>ExitOnForwardFailure=yes</string>
        <string>-R</string>
        <string>13000:localhost:3000</string>
        <string>user@your-server</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/persona-tunnel.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/persona-tunnel.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>AUTOSSH_GATETIME</key>
        <string>0</string>
    </dict>
</dict>
</plist>
```

启动：

```bash
launchctl load ~/Library/LaunchAgents/com.persona.tunnel.plist
```

管理：

```bash
# 查看状态
launchctl list | grep persona.tunnel

# 停止
launchctl unload ~/Library/LaunchAgents/com.persona.tunnel.plist

# 查看日志
tail -f /tmp/persona-tunnel.log
```

> **autossh 参数说明**：`-M 0` 禁用 autossh 自带的心跳端口，改用 SSH 原生的 `ServerAliveInterval` 检测连接存活。`AUTOSSH_GATETIME=0` 让 autossh 在首次连接失败时也立即重试。

## 第六步：开放云服务器安全组

如果公网服务器是云主机（腾讯云、阿里云、AWS 等），需要在控制台的**安全组**中放行入站端口：

| 方向 | 协议 | 端口 | 来源 |
|------|------|------|------|
| 入站 | TCP | 14242 | 0.0.0.0/0 |

## 第七步：SSH 服务端配置检查

确认公网服务器的 `/etc/ssh/sshd_config` 包含：

```
GatewayPorts clientspecified
```

如果只需要 127.0.0.1 监听（Nginx 和隧道在同一台机器），默认配置即可。如果需要隧道端口直接对外监听，需设为 `yes` 或 `clientspecified`。

## 验证

```bash
# 1. 确认隧道端口在服务器上监听
ssh user@your-server "ss -tlnp | grep 13000"

# 2. 服务器本地测试
ssh user@your-server "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:13000/"
# 期望: 200

# 3. 外部 HTTPS 测试（无认证，期望 401）
curl -sk -o /dev/null -w "%{http_code}" https://your-domain.com:14242/
# 期望: 401

# 4. 外部 HTTPS 测试（带认证，期望 200）
curl -sk -u "pshell:your-token" -o /dev/null -w "%{http_code}" https://your-domain.com:14242/
# 期望: 200
```

## 前端静态部署

Nginx 推荐配置为：静态文件从服务器本地 serve（`/assets/`、`/index.html`），只有 `/api/` 和 `/ws` 走隧道。这样前端加载不经过隧道，速度更快。

Nginx 配置示例：

```nginx
server {
    listen 14242 ssl;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    root /var/www/pshell-ui;
    index index.html;

    # 带 hash 的静态资源，长期缓存
    location /assets/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # API 走隧道
    location /api/ {
        proxy_pass http://127.0.0.1:13000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    # WebSocket 走隧道
    location /ws {
        proxy_pass http://127.0.0.1:13000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### 手动同步

Persona Shell 启动时只负责构建和托管本机 `web-v2/dist`。远程静态站点同步走手动命令或独立运维脚本，避免启动本地服务时触发远程写入。

```bash
cd ~/github/jzlikewei/persona-shell/web-v2
bun run build
rsync -az --delete dist/ user@your-server:/var/www/pshell-ui/
```

`/api/` 和 `/ws` 仍通过 SSH 隧道回到本机 Shell，静态资源由公网服务器直接提供。

## 安全注意事项

- **Token 认证**：pshell 内置 token 同时保护 HTTP API（`Bearer` header）和 WebSocket（`?token=` query param）。前端 401 时自动弹出 token 输入框
- **SSH 密钥**：隧道使用 SSH 密钥认证，不要用密码认证
- **证书续期**：Certbot 自动续期，无需手动操作
- **隧道监控**：autossh 断线自动重连；`KeepAlive` 确保 launchd 在进程退出后重新拉起

## 替代方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| **SSH 隧道 + Nginx**（本文） | 零额外依赖，标准运维 | 隧道偶尔断连需 autossh |
| **frp** | 专业内网穿透，自动重连更稳 | 多一个进程和配置文件 |
| **Tailscale** | 最省事，P2P 直连，不需要公网服务器 | 只有装了 Tailscale 的设备才能访问 |
