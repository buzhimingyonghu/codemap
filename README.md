# Codemap

一个精简、离线的 macOS 代码编辑器，面向 Apple Silicon（M 系列芯片）。只保留写代码最核心的功能：文件管理、编辑、编译、Git、断点调试和函数调用栈。其他功能都可以写成插件加进来。

[English](README.en.md)

- 技术栈：Electron 44 + React 19 + Monaco 0.57（VS Code 同款编辑器内核），全部用 TypeScript 编写
- 没有插件市场、没有遥测、不检查更新，界面本身不能联网
- 调试使用 Xcode 命令行工具自带的 `lldb-dap`，支持 C、C++、Objective-C、Swift、Rust
- 跳转到定义、查找引用、悬停提示通过语言服务器（LSP）实现，C 系列和 Swift 开箱即用

## 环境要求

| 依赖 | 版本 | 安装方式 |
| --- | --- | --- |
| macOS | 12 及以上，Apple Silicon | |
| Node.js | 22 及以上 | `brew install node` |
| git | 任意较新版本 | Xcode 命令行工具自带 |
| Xcode 命令行工具 | 提供 clang 和 lldb-dap | `xcode-select --install` |

检查环境：

```sh
./scripts/codemap.sh doctor
```

## 快速开始

```sh
git clone <仓库地址> codemap-ide
cd codemap-ide
./scripts/codemap.sh setup     # 安装依赖并下载 Electron 运行时
./scripts/codemap.sh dev       # 以开发模式启动，改界面代码会自动刷新
```

## 常用命令

推荐使用 `scripts/codemap.sh`，它会自动补齐缺失的依赖和图标。直接用 npm 也可以。

| 用途 | 脚本 | npm |
| --- | --- | --- |
| 检查环境 | `./scripts/codemap.sh doctor` | |
| 安装依赖 | `./scripts/codemap.sh setup` | `npm install` |
| 开发模式启动（热更新） | `./scripts/codemap.sh dev` | `npm run dev` |
| 生产模式预览（不打包） | `./scripts/codemap.sh start` | `npm run build && npm start` |
| 类型检查 + 单元测试 | `./scripts/codemap.sh check` | `npm run check` |
| 端到端测试 | `./scripts/codemap.sh e2e` | `npm run build && npm run test:e2e` |
| 只打包 .app（最快） | `./scripts/codemap.sh app` | `npm run package:dir` |
| 打包 .app + .dmg + .zip | `./scripts/codemap.sh package` | `npm run package` |
| 打包并安装到“应用程序” | `./scripts/codemap.sh install` | |
| 打开已打包的 App | `./scripts/codemap.sh open` | |
| 重新生成图标 | `./scripts/codemap.sh icon` | `npm run icon` |
| 清理构建产物 | `./scripts/codemap.sh clean` | `npm run clean` |
| 清理后重新安装依赖 | `./scripts/codemap.sh reset` | |

## 打包

```sh
./scripts/codemap.sh package
```

产物都在 `release/` 目录下：

```text
release/mac-arm64/Codemap.app        可以直接双击运行
release/Codemap-0.1.0-arm64.dmg      安装包，打开后把 Codemap 拖进“应用程序”
release/Codemap-0.1.0-arm64-mac.zip  压缩包
```

目前使用本机临时签名（ad-hoc），在本机可以直接运行。拷贝到其他 Mac 会被系统的 Gatekeeper 拦截，有两种处理方式：

- 临时使用：在 Finder 里右键 App 选择“打开”，或者执行 `xattr -dr com.apple.quarantine /Applications/Codemap.app`
- 正式分发：在 `electron-builder.yml` 里把 `mac.identity` 改成你的 Developer ID 证书，并开启 `notarize`

版本号在 `package.json` 的 `version` 字段里修改。

## 使用说明

| 操作 | 快捷键 |
| --- | --- |
| 打开文件夹 | ⌘O |
| 快速打开文件 / 命令面板 | ⌘P / ⇧⌘P |
| 在所有文件中搜索 | ⇧⌘F |
| 保存 / 全部保存 | ⌘S / ⌥⌘S |
| 编译 | ⇧⌘B |
| 开始或继续调试 | F5 |
| 单步跳过 / 单步进入 / 单步跳出 | F10 / F11 / ⇧F11 |
| 切换断点 | F9，或点击行号左侧 |
| 跳转到定义 | F12，或按住 ⌘ 点击函数名 |
| 在当前位置预览定义 | ⌥F12 |
| 跳转到实现 | ⌘F12 |
| 查找所有引用 | ⇧F12 |
| 当前文件的符号列表 | ⇧⌘O |
| 返回 / 前进 | ⌃- / ⌃⇧- |
| 转到上次编辑位置 | ⌘K ⌘Q |
| 显示或隐藏侧栏 / 底部面板 | ⌘B / ⌘J |
| 打开或隐藏终端 / 新建终端 | ``⌃` `` / ``⌃⇧` `` |
| 设置 | ⌘, |

**搜索**：左侧活动栏的放大镜（或 ⇧⌘F，编辑器里选中的文字会自动填进去）在整个文件夹里搜索文本。输入框右侧可切换区分大小写、全字匹配和正则表达式；点开左边的箭头可以替换（正则支持 `$1`、`$<name>`），点 ⋯ 可以填写包含/排除的文件（如 `src/**, *.ts`）。结果按文件分组，单击跳到对应位置并选中；↑↓ 可以逐条预览。已在编辑器中打开且未保存的文件按编辑器里的内容搜索和替换（可撤销），其他文件直接改磁盘。git 仓库里会跳过 `.gitignore` 忽略的文件，二进制和大于 4 MB 的文件不搜索，最多显示 2000 条结果。

**文件管理**：在左侧文件树里选中文件或文件夹后：

| 操作 | 方式 |
| --- | --- |
| 复制 / 剪切 / 粘贴 | ⌘C / ⌘X / ⌘V，或右键菜单 |
| 制作副本 | ⌘D，或右键“Duplicate” |
| 从 Finder 复制进来 | 在 Finder 里 ⌘C，回到 Codemap 文件树选中目标文件夹后 ⌘V |
| 从 Finder 拖进来 | 把文件或文件夹拖到文件树里的目标文件夹上（复制，原文件不动） |
| 在文件树里移动 | 拖到另一个文件夹上；按住 ⌥ 拖动则是复制 |
| 新建 / 重命名 / 移到废纸篓 | 右键菜单，或 Enter 重命名、⌘⌫ 删除 |

重名时会像 Finder 一样自动命名为 `xxx copy`、`xxx copy 2`。Codemap 里复制的文件也能直接在 Finder 里粘贴。出于安全考虑，只能往当前打开的文件夹里放东西，移动也只限于这个文件夹内部，不会动到外面的文件。

**地图模式**：标题栏右侧的开关（或 ⇧⌘M）把文件管理器从文件树切换成“项目地图”。整个项目是一块大陆，每个文件夹是一片领土，文件是领土上的城镇；同一批文件每次画出来的地图都一样，位置看久了就记住了。

| 操作 | 方式 |
| --- | --- |
| 进入一个文件夹 | 点击它的领土，或把鼠标放在上面用滚轮放大，越过阈值时会自动钻进去 |
| 回到上一层 | Esc、点击空白处、右键空白处，或者滚轮缩小 |
| 回到全图 | Home，或右下角的定位按钮 |
| 打开文件 | 点击城镇：镜头俯冲过去，编辑器从地图上升起 |
| 从编辑器回到地图 | Esc，或标签栏右侧的 MAP 按钮；再按一次 ⇧⌘M 也可以来回切换 |
| 新建、重命名、复制、删除等 | 右键城镇或领土；也可以把文件从 Finder 或地图外拖到某片领土上 |

**按前缀分区**：一个文件夹里名字前缀相同的文件或子文件夹会聚成一个分区，不管数量多少。分区有发光的实线边界，边界上写着前缀和数量，比如 `add 51`。文件名开头的编号（`0001_`）不算前缀，所以迁移脚本会按 `add`、`alter`、`create`、`update` 分开；分区很大时会继续往下分，比如 `api` 下面再分 `ap`、`eu`、`na`。只出现一次的前缀不单独成区。

文件很多时，地图会放大到每个名字都能看清，分区里的文件按名字顺序从上到下、一列一列排好，看不完的部分在上下左右，滚动或拖动去看；⌘ 加滚轮或双指捏合是缩放，按 0 看整个文件夹。右侧 PREFIXES 列出当前文件夹的所有分区（嵌套的可以展开），当前看到的会高亮，点一下直接飞过去。点击、面包屑、跳转进入文件夹都会计次数，右侧 FREQUENT 列出最常去的文件夹。

亮点代表常用文件：根据你在 Codemap 里打开它的次数（14 天半衰期）和最近的 git 提交频率算出来，右上角的 PEAKS 列出当前范围里最常用的几个，点一下直接打开。橙色表示有未提交的改动。使用记录只存在本机，右下角的按钮可以清空。地图只显示 git 跟踪的文件和没有被忽略的新文件，`node_modules`、构建产物不会出现；超过 2 万个文件时只显示前 2 万个。

**终端**：底部面板的“终端”标签页是一个完整的终端，用你的登录 shell（通常是 zsh），起始目录是当前打开的文件夹，颜色、vim、top 这类全屏程序都能正常用。可以同时开多个终端，右侧列表切换；切换文件夹时旧终端会关掉，在新文件夹里重新开。⌘K 清屏，⌘C / ⌘V 复制粘贴。

**编译和调试**：在设置（⌘,）里给每个文件夹单独配置构建命令和要调试的程序，比如：

```text
构建命令：mkdir -p build && clang -g -O0 src/*.c -o build/app
调试程序：build/app
```

编译报错只要是常见的 `文件:行:列: error: …` 格式（clang、gcc、swiftc、rustc、go、tsc），就会列在 Problems 面板里，点一下跳到对应位置。调试前可以设置先自动编译一次。

**Git**：支持切换和新建分支、暂存、丢弃改动、提交、修改上次提交、查看差异和提交历史。拉取和推送只在你手动点击时执行，使用你本机已有的 git 账号配置。

**跳转到定义**：靠语言服务器理解代码。打开对应语言的文件时，Codemap 会自动在后台启动语言服务器，状态栏右下角会显示它的名字，绿色表示已就绪，点一下可以重启。所有语言服务器的状态在设置（⌘,）里也能看到。

| 语言 | 语言服务器 | 是否需要安装 |
| --- | --- | --- |
| C / C++ / Objective-C | clangd | 不需要，Xcode 命令行工具自带 |
| Swift | sourcekit-lsp | 不需要，Xcode 命令行工具自带 |
| Rust | rust-analyzer | `rustup component add rust-analyzer` |
| Go | gopls | `go install golang.org/x/tools/gopls@latest` |
| Python | pyright | `npm install -g pyright` |
| TypeScript / JavaScript | typescript-language-server | `npm install -g typescript typescript-language-server` |

装好之后在设置里点重启，或者重新打开文件夹。

`go install`、`cargo`、`npm -g` 默认把程序装在 `~/go/bin`、`~/.cargo/bin`、npm 全局目录这些位置，它们通常不在 PATH 里。Codemap 会自动去这些目录找，不需要改 PATH。

打开的文件夹下如果有多个仓库（比如打开 `~/dev/shop`，下面有 `order-svc`、`payment-svc` 等），Codemap 会从当前文件往上找 `go.mod`、`Cargo.toml`、`package.json`、`.git` 这类标记，给每个仓库单独启动一个语言服务器。效果和单独打开那个仓库一样。

C 系列项目有一点需要注意：clangd 要知道每个 `.c` 文件是怎么编译的，才能从调用处跳到另一个 `.c` 文件里的实现。不然只能跳到头文件里的声明。Codemap 会按下面的顺序查找编译信息：

1. 项目根目录或 `build/` 下的 `compile_commands.json`（CMake 加 `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON` 会生成，Makefile 项目可以用 `bear -- make` 生成）
2. 项目根目录下的 `compile_flags.txt`
3. 都没有的话，自动扫描源文件和头文件目录，在 `.codemap/compile_commands.json` 生成一份，这个目录已经被 git 忽略

头文件路径比较复杂的项目，建议用第 1 种方式，结果最准确。

跳到项目外的文件（比如系统 SDK 的头文件）时，会以只读方式打开。

**代码地图**：标题栏右侧开关的第三个按钮（或 ⇧⌘Y）。打开的文件夹里（本身或往下两层）有 codemap/v1 节点库时，主区域显示可以逐层钻取的执行流地图，比如打开 `~/dev/shop` 会自动找到其中的节点库；找到多个时让你选一个，找不到时可以手动选择节点库目录。

| 操作 | 方式 |
| --- | --- |
| 进入一个组件 / 函数 | 双击带 ⤢ 的节点，或把鼠标放在上面用滚轮放大；单击只在右侧看详情 |
| 回到上一层 | 点面包屑、左上角的上箭头，或者滚轮缩小 |
| 换一张地图 | 工具栏左侧的下拉框 |
| 播放流程 | 右侧“流程”标签选流程、看步骤；画布右下角播放 / 单步 / 重置，点步骤可以跳到任意一步 |
| 看详情 | 点节点、连线、小球、结构体字段；右侧显示接口、数据字段、代码片段和知识库，接口可以展开多个 |
| 编辑节点 | 详情标题旁的铅笔：改名称、简介、描述、触发、结果，保存只改这几个字段 |
| 排布局 | 画布右上角“编辑布局”：拖节点、点中连线后拖两端圆点换边，保存后写进地图 YAML 的 `layout` / `ports`；取消放弃，⌘Z 撤销 |
| 流动小球 | 工具栏 关 / 聚焦 / 全部；默认聚焦：平时只有淡淡的方向虚线，悬停节点或点中连线时才跑小球 |
| 循环和协程 | 起协程的线是紫色；监听节点框内有水波纹，定时节点按周期亮一下；连成环的函数节点自动框成一个循环，编辑布局时整体拖动 |
| 看代码 | 详情里的代码片段按行号高亮；点“在编辑器中打开”升起编辑器，Esc 回到地图 |
| 从代码找节点 | 编辑器右键“在代码地图中显示”，或命令面板 `Show in Code Map` |
| 需求层 | 右侧需求列表，点一下叠加显示新增 / 修改 / 删除和改动角标，再点一下关掉 |
| 校验结果 | 工具栏的校验按钮，或底部面板的“代码地图”标签；点一条打开对应的 YAML |

改了节点库里的 YAML 会自动重新读取。保存或在外部改了某个节点指向的代码文件，节点和它上层的地图节点会出现一个小圆点，表示读取地图后代码改过。

代码地图每次更新的内容见文末的 [更新记录](#更新记录)。

**读取权限**：代码地图会读节点库、节点指向的代码和文档。打开的文件夹之内直接读；要读外面的目录（比如 Go 模块缓存里的 SDK）时，先弹出系统对话框问一次，允许后只读访问这个目录，以后不再问。允许过的目录在 设置 → 代码地图 里可以撤销；整个主目录或根目录不能一次性授权。

**主题**：内置 Graphite、Paper、Midnight 三套主题，在设置里切换，或者在命令面板里输入 `theme`。

## 目录结构

```text
src/main        主进程：窗口、IPC、文件读写、构建任务、git、DAP 调试客户端、插件发现
src/preload     界面和主进程之间唯一的桥：window.codemap（类型定义在 src/shared/api.ts）
src/shared      两边共用的类型和纯函数（路径、编译报错解析、git 输出解析、代码地图规则）
src/renderer    React 界面、Monaco 编辑器、主题变量、插件宿主
plugins/        内置插件，打包时会复制到 App 的 Resources/plugins
scripts/        开发脚本 codemap.sh 和图标生成脚本
build/          打包资源：应用图标、签名 entitlements
tests/unit      单元测试（Vitest）
tests/e2e       端到端测试（Playwright 驱动真实的 Electron App）
```

**代码地图规则**：codemap/v1 的建索引、校验、需求变更集都在 `src/shared/codemap/codemap.mjs`，读节点库目录在 `src/main/codemap/loadLibrary.mjs`。这是唯一的一份，原来的 `~/dev/ai/codemap-site` 已冻结。测试用的示例节点库在 `tests/fixtures/codemap-demo/`。命令行校验：

```sh
./scripts/codemap.sh codemap [节点库目录] [--index] [--all]   # 不写节点库目录时用当前目录
npm run codemap:validate -- [节点库目录] [--index] [--all]
```

有错误时退出码为 1；`--index` 额外打印“代码文件 → 节点”反查索引，`--all` 逐条列出提示级别的问题。

**AI 助手**：代码地图右侧的「AI」页签。有四种模式：

| 模式 | 做什么 | 和地图怎么联动 |
| - | - | - |
| 问答 | 问系统怎么运作 | 助手查到哪里，地图就打开对应的层级、点亮相关节点；讲流程时会选中对应的 flow，可以直接播放 |
| 调整 | 拆分、合并、补分支、改名 | 改动先作为一层「✦ 提议」叠在地图上（新增绿、修改黄、删除红），校验通过后点「写入」才落盘 |
| 新建 | 从代码和文档新建一张地图 | 一层一层往下画，每个阶段停在「待审」，你点通过或写意见；同层多个节点可以交给并行的子 agent |
| 需求 | 描述需求，得到影响分析和测试点 | 改动保存为 `requirements/<id>.yaml`，用现有的需求层显示 |

助手不会直接改文件：所有改动都是一组「变更集」，先在地图上预览、跑一遍校验，你确认后才写入。写入时保留 YAML 里的注释和格式。对话按节点库保存，可以在历史里切换。

模型在 设置 → AI 助手 里配置。默认用 **本机网关**：如果本机已经给 Claude Code 或 Codex 配置了模型网关，直接复用它的地址和令牌，不需要填密钥，模型列表从网关实时获取。也可以添加 OpenAI 兼容或 Anthropic 接口的服务，密钥用系统钥匙串加密保存。每种模式可以单独指定模型。

每种模式按什么流程做，写在节点库的 `_agent/` 文件夹里（设置里点「打开知识库」会建好空文件）：`common/` 通用规则、`create/SOP.md` 新建流程和模板、`ask/`、`adjust/`、`require/` 各模式的规范、`domain/` 业务知识。空文件会跳过，改完下次运行就生效。

**安全模型**：界面运行在沙盒里并开启了上下文隔离，所有文件路径都限制在当前打开的文件夹内，所有非本地的网络请求都会被拦截。插件如果需要联网，要调用 `ctx.net.fetch`，这个请求在主进程执行，而且只允许访问插件在 `plugin.json` 里声明过的地址。

## 编写插件

一个插件就是一个文件夹，包含 `plugin.json` 和一个 ES 模块，不需要构建步骤。把文件夹放到下面的位置，然后在插件面板里点“重新加载”：

```text
~/Library/Application Support/Codemap/plugins/<插件名>/
```

如果你的插件 id 和内置插件相同，会替换掉内置的那个，方便在内置插件的基础上修改。

`plugin.json`：

```json
{
  "id": "repo-map",
  "name": "Repo Map",
  "version": "0.1.0",
  "renderer": "index.js",
  "permissions": { "network": ["https://api.example.com"] },
  "contributes": { "commands": [{ "id": "repo-map.build", "title": "生成仓库地图" }] }
}
```

`index.js`：

```js
export function activate(ctx) {
  ctx.commands.register('build', async () => {
    const files = await ctx.workspace.findFiles()
    ctx.ui.notify(`共 ${files.length} 个文件`)
  })
  ctx.views.register('map', {
    title: '仓库地图',
    location: 'panel', // 或 'sidebar'
    mount(element) {
      element.textContent = '这里可以用任何方式渲染：React、D3、Three.js、iframe……'
      return () => element.replaceChildren()
    }
  })
}
```

完整的插件 API 在 `src/renderer/src/plugins/api.ts`，包括 `commands`、`views`、`workspace`、`editor`、`git`、`ui`、`storage`、`net` 和 `services`。

`services` 用来让插件之间互相配合，而不用互相引用代码。比如 AI 插件调用 `ctx.services.provide('ai', { ask })` 提供服务，架构图插件用 `ctx.services.get('ai')` 来调用它。

插件视图会继承主题的 CSS 变量（`--bg-editor`、`--fg-primary`、`--accent` 等），自定义的界面会自动跟随当前主题。`plugins/hello-codemap` 是一个完整可运行的示例。

## 自定义主题

界面的颜色、圆角、动画时长都定义成 CSS 变量，放在 `src/renderer/src/styles/tokens.css`。编辑器对应的配色在 `src/renderer/src/editor/themes.ts`。新增一套主题，就在这两个文件里各加一段。

## 测试

```sh
./scripts/codemap.sh check     # 类型检查 + 单元测试
./scripts/codemap.sh e2e       # 测开发构建
npm run test:e2e:agent       # 测 AI 助手（需要本机网关，会向模型发两条很短的消息）
CODEMAP_LIVE_AGENT=1 npx vitest run tests/unit/agent.live.test.ts   # 不起界面，直接测 agent 循环
npm run test:e2e:app         # 测已打包的 Codemap.app（先运行 ./scripts/codemap.sh app）
```

端到端测试会创建一个临时的 C 项目，依次测试：打开、编辑、保存、编译报错、跳转到报错位置、提交、查看差异、断点调试、单步执行、插件视图。截图保存在 `tests/e2e/artifacts/`。

## 常见问题

**`npm install` 之后启动报 Electron 找不到**：执行 `node node_modules/electron/install.js` 手动下载运行时，或者运行 `./scripts/codemap.sh setup`。

**编译命令找不到 brew 安装的工具**：Codemap 启动时会读取你登录 shell 的 PATH。如果是刚安装的工具，重启一下 Codemap。

**调试时提示找不到 lldb-dap**：执行 `xcode-select --install` 安装 Xcode 命令行工具。

**调试时断点不生效**：确认编译时带了 `-g`，并且关闭优化（`-O0`）。

**跳转到定义只跳到了头文件**：clangd 还没有拿到 `.c` 文件的编译信息，或者后台索引还没建完。等几秒再试；如果一直不行，按上面的方法提供 `compile_commands.json`，然后在状态栏点 clangd 重启。

**状态栏没有显示语言服务器**：当前文件的语言没有对应的语言服务器，或者还没安装，在设置的语言服务器列表里可以看到原因。

**Go 项目跳转不了**：先在终端确认 `go env GOPATH` 下的 `bin/gopls` 存在，没有就执行 `go install golang.org/x/tools/gopls@latest`。项目第一次打开时，gopls 需要加载依赖，大项目可能要等几秒到几十秒；依赖没下载过的话，先在项目目录执行一次 `go mod download`。

## 更新记录

按日期记录，每天分“IDE”和“代码地图”两部分。代码地图节点库的写法以 `agent/create/` 里的模板为准。

### 2026-11-08

#### 代码地图

新增
- 待办：两种来源合在一起显示。节点 yaml 里的 `issues`（看代码时发现、这次不修的疑点，每条写 `desc`，可以带 `code`）；每个文件夹 `todo/` 里的 `.md`（一件事一个文件，取第一行 `#` 标题）
  - 图上：有待办的节点右上角一个橙色数字，包含它里面所有节点的待办，悬停看前几条
  - 详情：和知识库一样单独一节“待办”，`issues` 带代码的可以展开看高亮的那几行，`todo` 文件点一下在编辑器里打开
  - 汇总：工具栏“待办 N”列出整个库的待办，按节点分组；还没建节点的文件夹单独列出。底部面板“代码地图”标签里也有一组
  - 改了 `todo/*.md` 会自动刷新

优化
- `issues` 的 `code` 只写行号时，指节点自己代码文件里的行；节点的 `issues` 不再报“不认识的字段”

### 2026-11-05

#### 代码地图

新增
- 协程 / 线程：起协程或线程的那条线写 `mode: go` 或 `mode: thread`。还是原来那条线，换成紫色、只有去的方向、只跑去程小球，悬停显示“协程”或“线程”；悬停、选中、播放时颜色不变
- 函数类型：函数写 `fn.type: listen`（监听：订阅、channel、watch）或 `fn.type: timer` 加 `fn.every: 5s`（定时）。监听节点在框内有水波纹，定时节点按周期亮一下，只在节点所在的图上显示
- 循环：函数节点用普通连线连成一个环，就自动识别成一个循环（`for { select }`），外面画一个框，左上角写行号；回到循环开头的线沿框的左边走，不穿过中间。编辑布局时，拖框里任意一个节点或拖框本身，整个循环一起移动

优化
- 闸门（写了 `check` 的节点）的分支可以写条件文字（`when: 是 leader`），不再限定 pass / fail，可以有多条分支；条件显示在线上
- 同一对节点之间按接口分成几条线时，上层对应的连线把这几条线的接口合起来比对（`edge-lift`）
- 自动布局时，循环框外的节点不会压在框上
- 调用两边都要说明（`edge-mutual`）放宽：上层画 `下单 → 共用`，下层画 `admit → 组状态`（组状态在共用里面）也算对上，`via` 仍要合起来对得上；只用来归类、自己没画连线的框（比如「共用」）不要求再画一遍

不兼容
- `fn.type` 只能写一种；`timer` 必须写 `every`，`every` 只能配 `timer`（`fn-type`）
- `mode` 只能是 `go` / `thread`，而且只能写在 `call` / `send` 线上（`edge-mode`）

### 2026-11-04

#### IDE

新增
- 前进 / 后退：标题栏搜索框左边的 ← →，或 ⌃- / ⌃⇧-，鼠标侧键也可以；切换文件（标签、文件树、地图、⌘P、转到定义等任何方式）和同一文件里光标一次移动超过 10 行都会记录，相近位置合并成一条，最多 50 条
- 转到上次编辑位置：⌘K ⌘Q，也在“转到”菜单和命令面板里
- 文件树和项目地图的右键菜单加了“在文件夹中查找…” / “在文件中查找…”：打开搜索并把范围限定在这个文件夹或文件，范围显示在“包含的文件”里

优化
- 记录的位置会跟着编辑移动：上面插入或删除了行，后退仍回到原来那段代码；文件重命名后记录跟着改
- ⌃- / ⌃⇧- 在终端和输入框里也能用；连续快按会依次执行，不会丢
- 用 ↑↓ 预览搜索结果只算一步，单击或回车才算一次跳转

修复
- 原来只有转到定义这类跳转才记录，点标签、文件树、⌘P 换文件都不记，后退回不去
- 跨文件后退后，到达新文件被误记成一次新跳转，前进历史被清空
- 后退到已删除的文件会报错，现在自动跳过；切换项目后清空历史

#### 代码地图

新增
- 心跳写在链路上：`links.yaml` 里给接口加 `heartbeat: true`（周期由客户端配置）或 `3s` 这类周期；`via` 带了这个接口的业务线上显示跳动的红点，不用再单独画一条心跳线
- 右侧详情可以编辑节点：名称、简介、描述、触发、结果，保存只改这几个字段，注释和其他内容不动
- 流动小球分三档：关 / 聚焦 / 全部

优化
- 默认“聚焦”：平时只有带 `via` 的线上显示淡淡的方向虚线；悬停或点中节点时，它进出的线才跑请求小球；点中连线时请求和返回都跑
- 单击节点只看详情，双击或放大才进入下一层
- 编辑布局时连线端点的圆点固定为屏幕上 7px，缩放后不再变小
- 有未保存的布局时切换地图，确认框默认按钮改成“取消”，回车不会误保存

修复
- 需求层开着时编辑布局，拖连线端点没反应、点“取消”后节点停在原处（看起来像已保存）；现在编辑时自动关掉需求层，取消 / 保存 / 撤销后都按文件重新布局
- 保存连线端点时报“Bad ports”：自动选边写成了 `auto`，现在按不写处理

不兼容
- 连线上的 `signal` / `period` 不再支持，写了报 `edge-heartbeat`；`heartbeat` 不是 `true` 或周期时报 `link-heartbeat`

### 2026-11-03

#### IDE

新增
- 搜索：左侧活动栏的放大镜或 ⇧⌘F，在整个文件夹里搜索；支持区分大小写、全字匹配、正则，包含 / 排除文件，单条、单个文件或全部替换（正则可用 `$1`、`$<name>`）；结果按文件分组，单击跳到并选中匹配
- 未保存的文件按编辑器里的内容搜索和替换，可撤销；其他文件直接改磁盘
- 保存或磁盘上的文件变化后，搜索结果自动刷新；结果超过 2000 条时提示缩小范围

#### 代码地图

新增
- 编辑布局：画布右上角“编辑布局”，拖节点、点中连线后拖两端圆点换边，“保存”一次写进地图 YAML 的 `layout` / `ports`，“取消”放弃，⌘Z 撤销
- 泳道 `dock` 支持 `left` / `right`，放在地图最左 / 最右一列
- 新规则 `edge-mutual`：上层画了 A → X，X 的地图里要画出这条调用从哪来（或往哪去），两边都写 `via` 时要对得上
- 新规则 `fn-trigger`，检查函数的 `trigger` 是否是 grpc / http / tcp / mq / cron / func；协议新增 `tcp`

优化
- 布局只看泳道，不看 `kind`；泳道不画框和名字，只决定初始位置，`dock: top / bottom` 贴上下两边
- 链路详情改成可折叠的列表，可以同时展开多个；流程从底部移到右侧“流程”标签
- 连线端点圆点放大，位置对准线的实际端点

修复
- `{ ref }` 引用被当成包含：兄弟图之间互相要求重画连线（19 个 `edge-lift`）、误报包含成环；现在引用只算邻居
- 连线端点圆点在双向连线上偏离线端 5~6px，很难点中

不兼容
- 去掉“锁定布局”，改成显式的编辑 / 保存 / 取消
- `edge-refined` 警告换成 `edge-mutual` 错误

### 2026-11-02

#### IDE

新增
- 项目地图：标题栏开关（⇧⌘M）把文件树换成地图，文件夹是领土，文件是城镇；同前缀的文件和文件夹分区放在一起并有明显边界，区内文件多时按文件树顺序排列、可以拖动和缩放查看，旁边的前缀索引一键跳转；同层相邻区域用不同颜色
- 文件夹访问次数统计和“常去”列表；设置里可以调“每屏节点数”（默认 40）
- 中英文界面：设置或命令面板里切换，原生菜单一起切换
- 集成终端：底部面板，⌃` 显示或隐藏，⌃⇧` 新建，⌘K 清屏，可以开多个会话，打开的文件夹即工作目录

优化
- 地图区域从上到下按文件树顺序排列（点开头的配置、文件夹、文件）
- 合并的单子文件夹链在地图上只显示本层名字
- 取景扣掉右侧面板，边缘的节点也能拖到中间

#### 代码地图

新增
- 代码地图：从冻结的 `codemap-site` 移植到 Codemap，标题栏开关第三个按钮（⇧⌘Y）打开；支持逐层进入、播放流程、需求层、校验面板、从代码找节点
- 读取工作区外的代码（比如 Go 模块缓存）时弹窗授权，只读，可在设置里撤销
- 详情里的代码片段可以展开，按行号高亮，点击在编辑器中打开
- 命令行校验：`./scripts/codemap.sh codemap [节点库目录]`

优化
- 每个代码位置自带仓库：`fn: { repo, code }`、数据条目上写 `repo` + `code`，路径 = `repo.local` + 仓库根目录下的完整路径，不再依赖外层节点

修复
- 路径重复拼接 `repo.dir`（比如 `order/order/controller/...`）导致代码读不到
- 数据条目（如 `ListOrdersRequest`）的代码位置点击没反应，也不显示片段

不兼容
- 不再支持 `repo.dir`，写了报 `repo-dir`
