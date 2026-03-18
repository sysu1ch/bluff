# Hu Pai Online

一个基于 Node.js、Express 和 WebSocket 的多人唬牌小游戏。

## 功能

- 创建房间和房间码加入
- 加入房间前必须输入昵称
- 大厅期允许修改昵称，开局后锁定
- 同源 WebSocket 实时同步
- 支持部署到公网服务器后进行多人联机

## 本地启动

```bash
npm install
npm start
```

默认监听：

- `HOST=0.0.0.0`
- `PORT=3000`

浏览器访问 `http://localhost:3000`。

## 公网部署

服务端是单实例内存房间模型，部署时要求所有玩家连接同一个实例。

### 环境变量

- `HOST`: 监听地址，默认 `0.0.0.0`
- `PORT`: 监听端口，默认 `3000`

### 反向代理要求

- 需要把 HTTP 请求转发到 Node 服务
- 需要保留 WebSocket Upgrade 头，否则房间实时同步无法建立
- HTTPS 终止后，前端会根据当前页面协议自动改用 `wss://`

### 典型启动

```bash
HOST=0.0.0.0 PORT=3000 npm start
```

Windows PowerShell:

```powershell
$env:HOST="0.0.0.0"
$env:PORT="3000"
npm start
```

## 当前限制

- 房间和对局状态保存在进程内存中，服务重启后会丢失
- 不支持多实例横向扩展
- 不包含 NAT 穿透、P2P 房主直连或断线重连恢复
