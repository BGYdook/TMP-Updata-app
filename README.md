# TMP 更新工具

基于 [TMP File Mirror API](https://tmplistoss.bgydook.cn/docs/) 的本地客户端文件同步工具。

## 功能

- 拉取远端文件清单并按系统、欧卡、美卡筛选
- 比较本地文件大小与 MD5，自动标记缺失、过期和最新文件
- 流式下载，显示当前文件、总进度、下载速度、剩余时间和校验/安装阶段
- 网络中断、服务端限流或校验失败时自动重试两次；失败文件可一键重试
- 下载后强制 MD5 校验
- 用临时文件安装，并在覆盖前保留可恢复的本地备份
- 本地目录授权与 MD5 指纹缓存，减少重复计算
- 支持批量更新、取消、单文件重试和错误提示
- 桌面版自动读取 TruckersMP 的 `launcher-options.json`，启动时自动扫描
- 每 5 分钟自动重新检测客户端目录和文件差异，可随时关闭
- 可驻留系统托盘继续检测；新更新或后台更新结果通过系统通知提醒
- 导出包含版本、文件状态、错误和本次操作记录的 JSON 诊断日志
- 关于界面显示作者、GitHub/CNB 仓库，并从 CNB Release 检查和安装软件更新
- 浅色 / 深色主题切换，首次启动跟随系统并记住用户选择
- 保留仪表盘布局，目录卡片集中显示连接、检查和更新状态
- 按待更新、已是最新、检查异常筛选，待处理文件优先显示
- 每次检测后，有待更新文件时仅显示待更新项；全部最新时自动显示完整清单，也可手动切换筛选
- 文件详情显示大小、MD5、清单更新时间和完整失败原因
- “智能更新”处理全部待更新文件，“更新所选”仅处理勾选文件
- 更新结束后重新检查，保留失败原因并支持重试；自动检查期间刷新远端清单

## 运行

Windows 桌面版（推荐）：

```powershell
npm install
npm run desktop:dev
```

桌面版启动后会自动读取：

```text
%APPDATA%\TruckersMP\launcher-options.json
%LOCALAPPDATA%\TruckersMP\launcher-options.json
```

工具从其中的 `installPath` 定位 TruckersMP 的 `installation` 目录，并自动比较文件大小与 MD5。自动检测不会静默覆盖文件，实际更新前仍会显示确认窗口。

仅运行浏览器版本：

```powershell
npm install
npm run dev
```

打开终端输出的本地地址，建议使用最新版 Chrome 或 Edge。首次使用时选择一个可读写的 TMP 客户端目录，工具会在本地完成扫描和写入，不会上传客户端文件。

生产构建：

```powershell
npm run build
npm run preview
```

构建 Windows 安装包：

```powershell
npm run desktop:build
```

安装包输出到 `release/`。

## GitHub 同步到 CNB

项目已经提供两个 GitHub Actions：

- `.github/workflows/sync-cnb.yml`：每次向 GitHub 推送分支时，把同名分支推送到 CNB。
- `.github/workflows/release-cnb.yml`：推送 `v1.3.0` 这类版本标签时，构建 Windows 安装包，同时发布 GitHub Release 和 CNB Release 附件。

首次使用时，在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中配置：

| 名称 | 类型 | 内容 |
| --- | --- | --- |
| `CNB_USERNAME` | Secret | CNB 用户名 |
| `CNB_TOKEN` | Secret | CNB 个人访问令牌，需要仓库写入权限 |
| `CNB_REPO_SLUG` | Repository variable | CNB 仓库路径，例如 `你的组织/tmp-sync` |

CNB 仓库需要提前创建，并确保这个令牌可以推送代码和创建/上传 Release 附件。GitHub 和 CNB 的默认分支名称建议保持一致。令牌只放在 GitHub Actions Secret 中，不要写入工作流文件。

发布新版本的流程：

```powershell
# 先把 package.json 的 version 改成新版本
git add package.json package-lock.json
git commit -m "release: v1.3.0"
git tag v1.3.0
git push origin master --tags
```

如果你的 GitHub 默认分支是 `main`，把上面的 `master` 换成 `main`。推送完成后，在 GitHub Actions 页面可以看到 `Sync to CNB` 和 `Build and publish release to GitHub and CNB` 两个任务。工作流会检查标签版本是否和 `package.json` 一致，不一致时会停止发布，避免 GitHub 与 CNB 出现不同版本。

桌面版启动后会静默检查 CNB Release。发现新版本时，在“关于与使用说明”中点击“安装”即可下载 CNB 安装包并启动安装程序。安装程序启动后应用会退出，软件更新需要重启完成；文件更新和软件更新使用不同的流程。

应用图标为橙色卡车与更新箭头，包含 SVG 源文件、512 px PNG，以及 16–256 px 共 10 个尺寸的 ICO，位于 `public/app-icon.*`。Windows 程序、安装包和浏览器均已接入。修改 SVG 后可用 `npm run build:icons` 重新生成（需要 Chrome / Edge，或设置 `CHROME_PATH`）。

默认使用国内镜像下载 electron-builder 的 Windows 打包工具；如需切换镜像，可设置 `ELECTRON_BUILDER_BINARIES_MIRROR` 环境变量。

在开发服务器运行期间，可执行真实下载校验和界面扫描测试：

```powershell
npm run smoke:download
npm run smoke:ui
npm run smoke:native
npm run smoke:theme
npm run smoke:dashboard
```

测试使用隔离的临时目录和浏览器临时文件系统，不会读写真实客户端目录。`smoke:native` 覆盖自动路径检测、本地差异扫描、下载、MD5 校验和覆盖写入。

`smoke:dashboard` 使用模拟桌面桥和固定清单，覆盖筛选、文件详情、两种批量操作、取消、失败保留、定时刷新和窄窗口布局。

## 更新前

建议先退出欧卡 2 或美卡，避免 Windows 文件锁导致覆盖失败。TruckersMP 启动器可以保持打开。所有下载地址都会带上 `v={md5}` 参数，并在替换原文件前完成 MD5 校验。

桌面版在更新前会检查欧卡 2 和美卡进程是否仍在运行；TruckersMP 启动器可以保持打开。

## 浏览器支持

独立桌面版没有浏览器目录限制。浏览器备用模式依赖 File System Access API，因此需使用 Chromium 内核浏览器，并通过 `localhost` 或 HTTPS 访问。

## 发布版加固

- 渲染层、主进程和 preload 在打包前执行字符串编码、控制流变换、死代码注入、标识符重命名等混淆
- 关闭 source map、调试控制台输出和打包版 DevTools 快捷键
- 启用 Electron fuses，禁用 `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS` 和 Node 调试参数
- 启用 ASAR 完整性校验，并限制只能从 `app.asar` 加载应用代码
- IPC 仅接受当前应用主页面发起的调用
- 扫描和更新只允许使用自动检测或系统文件选择器确认过的 TruckersMP 目录
- API 地址固定，阻止清单和下载请求重定向到其他域名
- CSP 与网络白名单限制渲染层访问外部地址

这些措施能显著提高静态分析和运行时篡改成本，但客户端代码无法做到绝对不可逆向。正式对外分发时仍应使用可信的 Windows 代码签名证书，避免安装包被替换或冒名发布。
