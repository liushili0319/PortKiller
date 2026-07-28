# PortKiller

[English](README.md) | 简体中文

PortKiller 是一款 Windows 桌面端口控制台，可检查 IPv4 和 IPv6 的 TCP/UDP
端点，并安全终止实际占用所选端点的精确进程实例。项目使用 React 构建界面，
使用 Rust/Tauri 后端直接读取 Windows IP Helper 表。

![PortKiller 桌面端点控制台](docs/screenshots/portkiller-desktop.jpg)

> 截图使用固定的 Preview 示例数据。Preview 模式支持筛选、选择、刷新和复制，
> 但不会显示目录定位、权限提升或进程终止命令。

## 下载

请从 [GitHub Releases](https://github.com/liushili0319/PortKiller/releases/latest)
下载最新的已验证 Windows 版本。每个 Release 都包含原始 `PortKiller.exe` 和
SHA-256 校验文件。检查或终止其他用户、提权服务所拥有的进程时，Windows 可能
要求以管理员权限运行。当前可执行文件未进行代码签名，因此 Windows SmartScreen
可能显示警告；运行前请核对 Release 中公布的校验值。

## 主要功能

- 扫描 IPv4 和 IPv6 下的 TCP、UDP 端口绑定。
- 查看本地与远程端点、连接状态、地址族、PID、进程名、可执行文件路径和
  进程实例标识。
- 搜索全部端点、按协议筛选、精确定位端口、刷新数据，并复制端点或 PID。
- 在 Windows 桌面应用中通过资源管理器定位可执行文件，或以管理员权限重启。
- 支持键盘操作的端点表格、行菜单和危险操作确认对话框，并支持减少动态效果。
- 明确区分“已终止”“已经退出”“被拒绝”和“失败”，不会把所有后端响应都
  当成成功。

## 安全模型

终止进程会跨越具有破坏性的信任边界，因此 PortKiller 不会仅凭 PID 或进程名
执行操作。

- 界面原样转发后端生成的 `entry_id`、规范化端点、PID 和进程实例标识。
- 终止前，后端会重新验证条目标识、Windows 进程创建时间、保护状态和精确的
  端点所有权。
- 身份检查、存活检查、终止和退出确认始终使用同一个已保留进程句柄。
- 仅处理用户选中的 PID，不会扩展到同名进程、兄弟进程、父进程或整个进程树。
- 身份信息缺失、变化、受保护或存在歧义时，操作会安全失败。
- 只有 Windows 确认保留的进程句柄已进入有信号状态后，才会报告成功。

这些检查可降低界面数据过期和 PID 被复用带来的风险，但终止进程仍具有破坏性。
确认前请仔细检查所选可执行文件和端点。

## 最小窗口

桌面窗口在 980 × 640 下仍可正常使用。端点表格会保持操作列可见，数据列和
目标检查器则可在各自区域内滚动。

![PortKiller 在 980 × 640 最小窗口下的界面](docs/screenshots/portkiller-980x640.jpg)

## 技术栈

- Tauri 1 桌面外壳
- Rust 后端，通过 `windows-sys` 调用 Win32 API
- React 18、TypeScript 和 Vite 8 前端
- Vitest、Testing Library、ESLint、Rustfmt、Clippy 和 Cargo tests

## 环境要求

- Windows 10 或 Windows 11
- Node.js `^20.19.0`、`^22.13.0` 或 `>=24`
- npm 11（当前锁文件由 npm 11.9.0 管理）
- 带有 MSVC target 的较新稳定版 Rust 工具链
- Visual Studio C++ Build Tools，并安装“使用 C++ 的桌面开发”工作负载

## 开发

安装锁文件固定的依赖：

```powershell
npm ci
```

使用示例端点数据运行可复现的浏览器 Preview：

```powershell
npm run dev
```

运行真实的 Windows 桌面应用：

```powershell
npm run tauri -- dev
```

真实端口检查、路径定位、权限提升和进程终止仅在 Tauri 运行时中可用。浏览器
Preview 永远不会执行系统命令。

## 验证

运行完整的前端和 Rust 质量门禁：

```powershell
npm run check
```

该命令涵盖 TypeScript、零警告 ESLint、前端测试、真实 Web 构建输出隔离、
Rustfmt、拒绝警告的 Clippy，以及锁定依赖的 Rust 测试。可使用以下命令重新检查
依赖安全性：

```powershell
npm audit
npm audit --omit=dev
```

## 构建可执行文件

```powershell
npm run build:exe
```

原始 Tauri 可执行文件生成于 `src-tauri/target/release/PortKiller.exe`，并复制到
`dist/PortKiller.exe`。打包脚本使用锁文件安装的 Tauri CLI，不依赖 WiX/MSI
打包。

前端资源独立存放在 `dist/web`，因此 `npm run build` 不会覆盖或删除已有的
`dist/PortKiller.exe`。打包细节和故障排查请参阅
[`docs/packaging.md`](docs/packaging.md)。
