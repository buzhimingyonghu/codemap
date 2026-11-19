# 构建 map 的流程

把代码画成可逐层点开的地图。主交付是分层清楚的 **L0 全景 + L1 模块架构**。`fast` 和 `balanced` 停在 L1 的 `kind: component`，不自动生成 `kind: function`。函数和代码块只在用户显式点名单个节点，或主动选 `deep` 时才下钻。字段以 `node-template.yaml`、`link-template.yaml`、`requirement-template.yaml` 为准；会报错的规则见 `common/guide.md`。动手前用 `read_knowledge` 读模板。

```
A 准备 → B 全量盘点与业务理解 → C 结构化蓝图 →（按档位）D L0 → E 模块 → F 函数
```

用户选的建图档位 `buildTier` 与视角 `buildLens` 在系统提示里。没写时档位是 `balanced`，视角是 `service`。

---

## A 准备：分析哪些资料

用户在 Codemap 里会选好：

- **仓库**：一个或多个本地目录
- **知识库**：文件、文件夹、wiki 链接，或对话里口述
- 可选：业务名称、关注重点、档位、视角

只分析这些，不用再问范围。原始资料挂到根节点 `kb`。什么都没给时，先按业务名在打开的文件夹里列出候选仓库和文档，确认后再画。

## B 全量盘点与业务理解

只读，先不写文件。目标是一份可对账的入口清单，不是散文。

### B1 必调 `scan_repo_entrypoints` 全量预扫描

每个仓库动手前都调一次 `scan_repo_entrypoints`。参数用仓库绝对路径 `path`，以及准备写入的节点目录 `targetFolder`。一次拿全：

- 同步入口：HTTP / RPC / IPC / CLI
- 异步消费：MQ / Kafka / Watch
- 定时与常驻协程：Cron / Ticker / Goroutine
- 存储读写：DB / Redis / 对象存储
- 精确的 `git remote`，以及相对 `targetFolder` 的 `repo.local`

`repo.local` 只用这个返回值，或系统提示 `Where the user is` 里的相对路径。禁止猜 `../../` 的层数。再用 `read_file` 看关键入口和用户给的文档。文档与代码不一致时以代码为准，记在蓝图的分歧点里。

### B2 按建图视角归纳模块

视角来自用户所选 `buildLens`：

- **服务与存储（默认 `service`）**：按真实微服务、进程或独立子系统切 `component`。DB / Redis / MQ 全部画成 `resource`，同步调用和异步投递都画出来。禁止把多个独立服务揉进一个抽象产品名词框。
- **业务流程（`business`）**：按产品环节切。`brief` 写这个环节背后的服务名或仓库名。
- **排障与状态（`troubleshoot`）**：按核心业务对象的状态机切。超时、重试、幂等校验、失败回滚、后台巡检对账各自成流程，不藏进成功主路径。

一般 3～8 个模块。每个模块记下：仓库目录、归它的入口、上下游、读写的存储。

### B3 入口 100% 归属对账

`scan_repo_entrypoints` 扫出的每一类入口，尤其是异步消费者和定时任务，都要归进某个模块和某条流程。运维探针、生成代码、废弃入口可以不画，但必须单独写排除原因。静默漏掉算没完成 B。每个模块至少对应一个入口；用户、第三方这类外部节点标明没有本仓库代码。

对账表自己留着，后面写每张图时逐条勾。归进模块却没出现在任何流程里，和没归进去一样算漏。

排除项单独列成一行：入口位置、不画的原因（运维探针、生成代码或废弃）、依据的文件。没有这行就还没完成对账。

## C 结构化蓝图对齐

用紧凑表格，不写长篇散文。只在有真正分歧时才提问。写 YAML 前先在表里定好泳道和停靠。

1. **一句话定位**：做什么、给谁用。
2. **模块与存储拓扑**

| 节点 ID | 名称 | 类型 | 泳道与停靠 (lane/dock) | 对应服务/目录 | 覆盖入口（同步/异步/定时） |
| - | - | - | - | - | - |

泳道列写左→右业务列名（2～4 条，如 `接入层` / `核心编排` / `领域服务`），或 `dock: left` / `top` / `right` / `bottom`。调用方、存储、外部系统不要和业务模块写成同一列。

3. **核心流程**

| 流程 ID | 场景 | 类型(主流程/异常/后台) | 经过节点链路 |
| - | - | - | - |

4. **分歧点**：只列拿不准的架构选择。每条写代码位置、可选做法、推荐项。没有就写“无疑问”，不要凑问题。

`fast` 把这四段收进最终回复，不为此停下。`balanced` 和 `deep` 输出表格后才进入停顿。

## 三档建图节奏

B 的对账表三档都要做。差别只在停几次、画多深。三档都不批量铺函数图。

- **`fast`（快速全景）**：预扫描并对账后**不调 `review_gate`**。一次性提交 L0 全景、L1 模块骨架和根文档。自检 0 error 后直接交付草稿，回复附上 C 的蓝图摘要。L1 只画模块内部的 `kind: component` 块和入口归属，不生成 `kind: function`。
- **`balanced`（标准对齐，默认）**：输出 C 的表格后调一次 `review_gate`（阶段：蓝图），等用户拍板。通过后一鼓作气完成 L0 加 L1 模块子图，含核心链路 `links.yaml` 和模块说明文档。中间不再停。停在组件架构，不自动下钻函数。
- **`deep`（深度全量）**：按顺序停四次：蓝图确认 → L0 确认 → E 并行模块拆分确认 → F 核心函数与代码块逐层下钻。每一批下钻完再停一次。没选 `deep`、也没点名单个节点时，不要进入 F。

三档都先把 B3 的入口对完。档位只减少停顿和下钻深度，不减少入口覆盖。

## 架构图排版与层级红线（必守）

L0 和 L1 都按这四条画。

### 1. 严格分层泳道（左→右 2～4 条业务列 + 四边停靠带）

按数据或请求流向，把主链路拆成 **2～4 条命名泳道**（`lanes`），例如 `接入层 → 核心编排 → 领域服务 → 下游/通知`。禁止把 8 个模块塞进 1 条 `biz` 泳道竖着堆。每条业务泳道必须写清晰中文 `name`：画布会渲染泳道底框和层标题，`name` 是层标题，不是说明句。

非主链路写在泳道的 `dock` 上，不和业务列混排。主链路里的下游服务占业务列；图外的通知目标才用 `dock: right`。

- 调用方 / 客户端 / 触发源 → `dock: left`
- 配置中心 / 注册中心 / 鉴权 / 公共依赖 → `dock: top`
- 第三方外部系统 / 下游通知目标 → `dock: right`
- DB / Redis / MQ / 对象存储 / 日志存储 → `dock: bottom`

### 2. 密度与信息量硬上限

- 单张图：核心业务节点 ≤ 8，全部节点（含 dock）≤ 12。超过就先按域聚合成模块，再下钻到 L1。
- 单条业务泳道：≤ 4 个节点。
- 同层同粒度：L0 只放调用方、服务模块、外部系统、存储，不混函数或文件。L1 只放模块内部职责块（`kind: component`），不铺函数细节。

### 3. 命名与简短线标签

- `name`：**2～6 个中文字**（`订单服务`、`扣减库存`、`API 网关`）。禁止英文驼峰长名或整句描述。
- `brief`：**3～10 字技术定位**（`order-svc · gRPC`、`Redis Lua`、`orders 表`）。
- 连线 `name`：关键业务边写 **2～6 字动词短语**（`创建订单`、`锁定库存`、`发布事件`、`异步回调`）。静态图不点播放也能看懂关系，避免长句。

### 4. 黄金样板与反面清单

正例骨架（收紧自 `tests/fixtures/codemap-demo/library/order-system/order-system.yaml`：`dock: left` + 3 条业务列 + `dock: top` + `dock: bottom` + 短 `name` / `brief` / 边 `name`）：

```yaml
lanes:
  - { id: caller, name: 调用方, dock: left, nodes: [user] }
  - { id: access, name: 接入层, nodes: [gateway] }
  - { id: core, name: 核心编排, nodes: [order-svc] }
  - { id: domain, name: 领域服务, nodes: [inventory] }
  - { id: deps, name: 公共依赖, dock: top, nodes: [registry] }
  - { id: store, name: 存储, dock: bottom, nodes: [mysql, redis] }
contains:
  - { id: user, kind: component, name: 用户端, brief: App / H5 }
  - { id: gateway, kind: component, name: API 网关, brief: HTTP 转 gRPC }
  - { id: order-svc, kind: component, name: 订单服务, brief: order-svc · gRPC }
  - { id: inventory, kind: component, name: 库存服务, brief: Redis Lua }
  - { id: registry, kind: resource, resource: etcd, name: 注册中心, brief: etcd }
  - { id: mysql, kind: resource, resource: mysql, name: 订单库, brief: orders 表 }
  - { id: redis, kind: resource, resource: redis, name: 库存缓存, brief: Redis Lua }
edges:
  - { from: user, to: gateway, kind: call, name: 提交订单 }
  - { from: gateway, to: order-svc, kind: call, name: 创建订单 }
  - { from: order-svc, to: inventory, kind: call, name: 锁定库存 }
  - { from: order-svc, to: mysql, kind: call, name: 写入订单 }
  - { from: inventory, to: redis, kind: call, name: 扣减库存 }
```

反面案例（严禁）：

- 全塞一列：多个模块只写一条 `biz` 泳道，竖长堆叠。
- 不写 `dock`：把 DB / Redis 和业务服务混在同一列。
- 在 L0 / L1 里硬画 `kind: function`。
- 节点名超长（整句或英文驼峰），画布上被截断。

## D 写 L0

L0 是一张能播放的全景，不是函数图。排版按上一节：2～4 条左→右业务列，调用方、依赖、外部系统、存储分边停靠，全图 ≤ 12 个节点。

- 调用方放 `dock: left`，`kind: component`。业务模块 `kind: component`，`name` 用 2～6 个中文字，`brief` 写服务或仓库。外部系统 `dock: right` 或 `dock: top`。存储 `kind: resource`，`dock: bottom`；已有节点用 `{ ref, path }`。
- 同步交接 `kind: call`，异步 `kind: send`，返回 `return`。关键边写 2～6 字动词 `name`。跨服务边写 `via`。L0 链路可先写接口名和关键字段，完整字段在 L1 补。
- 每个用户操作一条 `flows`。明显失败单独一条；心跳、定时对账用 `kind: background` 加 `period`。
- 根文档 `docs/<id>.md` 按 `node-doc-template.md`，挂 `kb`。用户给的资料也挂上。
- L0 的模块先不画成函数。默认建图不展开函数和执行顺序。即使模块本身只是一两个函数，也先画成一个组件块；只有用户点名该节点或档位是 `deep` 时才进 F。

提交用 `propose_change_set` 的 `files`。一次一两份文件，之后 `extend: <id>`。写完之前不要修校验；写完后看最后一次回复，一次 `extend` 改完。`changes` 互相矛盾时加 `replaceChanges: true`。草稿写乱就 `discard_change_set({ id, reason })`，说明编号、标题和原因后再提。

`fast` 写完 L0+L1 后直接交付，不在这里停。`balanced` 的这一步已经包含在蓝图通过后的一口气里，不再单独停。`deep` 才在 L0 自检通过后停 `review_gate`（阶段：L0）。

写每张图都按“先整理、再写、最后统一校验”：先列节点角色、连线和流程步骤，对照“画函数图（执行图）的规则”；一次 `propose_change_set` 一两份文件，用 `extend` 合并；全部写完再一次改完 error。

同一路径再次写入会覆盖该文件的旧全文。`extend` 不会自动删除你没再提交的旧 `changes`；只有 `replaceChanges: true` 才换成这一次的变更列表。

## E 按模块拆分：多个子 agent 并行

`fast` 不做这一档的并行下钻。`balanced` 由主 agent 直接写 L1，不派子 agent，也不再停。`deep` 在 L0 确认后才 `delegate_nodes`。

### 前置跨模块契约

派发前主 agent 先固定共用契约，避免并行子代理互相等：

- 共用 DB / Redis / MQ 由主 agent 写成 `resource`，放在节点库公共位置，给出 `{ ref, path }`。
- L0 上跨模块的边和 `via` 先定稿：谁调谁、走哪条链路、是不是 `error`。
- 每个任务包写明：入边来源、出边目标、`refines` 的父流程 id（`<父图id>.<流程id>`）、该仓库精确的 `repo.local`。
- 子 agent 只写自己模块的文件夹。发现 L0 或别的模块要改，写进报告，由主 agent 改。
- 任务包里的入口按同步、异步、定时分列。子 agent 不得自行删掉异步消费者或定时任务。

### 子 agent 做什么

1. 读入口附近的代码，按任务包里的入口清单确认内部分块；异步消费者和定时任务不能漏。
2. 写 `<模块文件夹>/docs/<id>.md`（按 `node-doc-template.md`），挂到 `kb`；和 yaml 放进同一个提案。
3. 写模块 yaml：L1 先写 `kind: component` 的职责块，写清职责和入口，并守排版红线（左→右 2～4 列、`dock`、短 `name`、关键边的动词 `name`）。不在这一层铺 `kind: function`。只有任务是用户点名的单节点，或 `deep` 的 F，且这一层本身就是一两个函数时，才画函数图。函数节点写 `fn.repo` + `fn.code`。
4. 写 `links.yaml`：每个对外接口一条，字段照结构体，带 `repo` + `code`。
5. 自查：回复里没有 error；入边来源和出边目标都接上；`refines` 的进出顺序与父流程一致；说明文档和主流程一致。
6. 交回报告：画了什么、哪里不确定、要主 agent 改的父图或契约。

子 agent 不调 `review_gate`。草稿写乱时 `discard_change_set` 后重提，不要在坏 `changes` 上继续叠。

子 agent 交回前，自己的提案必须没有 error。主 agent 汇总时不再替它猜漏掉的边。

主 agent 收到报告后，先把 B3 清单再对一遍：每个异步消费者和定时任务要么出现在某个子图，要么仍在排除列表里。缺的由主 agent 补进对应模块，不重新全量扫描。

### 主 agent 汇总

核对三件事：一边的 `call` / `send` 另一边有对应边；流程能从上一模块接到下一模块；没有两个模块画同一段代码，也没有入口没人认领。需要改的自己改或再派一次。只有 `deep` 在这里停 `review_gate`（阶段：模块拆分）。

汇总时若发现契约写错（`via`、入边来源或 `refines` id），先 `discard_change_set` 丢掉写乱的子图草稿，改完契约再派一次。不要在错误契约上继续 `extend`。

## F 逐层往下：直到函数和代码块

**按需单点下钻（仅用户显式点名单个节点，或主动选 `deep` 时触发）。** `fast` / `balanced` 到 L1 的 `kind: component` 为止，不自动生成 `kind: function`。

批量自动铺函数图噪声大、行号脆、执行图校验重，容易在校验环里来回改。所以默认建图不做函数层拆解。用户点名时只拆那一个节点；`deep` 才沿核心路径逐批下钻。做法同 E：读代码、写文档、画图、自查。复杂节点交给子 agent。

| 层 | 节点是什么 | 按什么排 |
| - | - | - |
| L0 | 模块、调用方、外部系统、存储 | 一次操作的先后 |
| L1 | 模块里的服务或块 | 请求和数据的流向 |
| L2 | 职责块、入口函数 | 入口 → 处理 → 输出 |
| L3 及以下 | 函数里的步骤、判断、循环 | 代码执行顺序 |

- **该拆**：一个节点里有多个业务分支（不算 `if err != nil`、参数校验、默认值），或直接读写好几类存储。
- **不拆**：内部是顺序几步，`desc` 已经讲清。
- **到底**：函数内部代码块的 `fn.code` 只写行号，例如 `42-68`，不再写 `repo`。
- 一层只往下画一层。模块子图先画 `kind: component` 块，不在这一层铺函数。只有当前就是被点名的节点或 `deep` 的这一批，且这块本身就是一两个函数时，才直接画函数图。
- 用户在地图上点名某个节点，就只拆这个节点，不顺手拆它的邻居，也不要把整条链路补成函数图。

每层都要满足：父图进出的 `call` / `send` 在子图有对应边（`edge-mutual`、`edge-lift`）；子流程 `refines` 父流程且进出顺序一致（`flow-refines`）；同图粒度相近；父函数的每个业务分支落到某个子节点。`deep` 每拆完一批停一次 `review_gate`。

---

## 每张图怎么写

### 模板特性

| 特性 | 用在哪 | 怎么用 |
| - | - | - |
| `name` / `brief` / `desc` | 每个节点 | name 用业务话；brief 写服务名、函数名或关键参数 |
| `kb` | 每个有子图的节点 | 挂 `docs/<id>.md`，外部文档也挂 |
| `lanes` + `dock` | 每张图 | 调用方 left，依赖 top，存储 bottom，下游 right |
| `{ ref, path }` | 跨图节点 | 别的模块和共用存储用引用，不重复定义 |
| `edges.kind` | 每条线 | next 下一步，call 调用，send 投递，return 返回 |
| `edges.mode` | 不等待的调用 | `go` 或 `thread`，且 kind 只能是 call / send |
| `edges.via` | 跨服务、读写存储 | 指向链路 id；流程走过又没写 via 只是 info |
| `links.yaml` | 有接口的节点 | 一个接口一条；data 写 repo + code，或 missing |
| `when` / `error` / `swallow` | 分支 | 闸门至少两条出边；异常边 `error: true` |
| `fn.trigger` / `fn.serves` | 入口 | 图内不能有入边；serves 指向链路 |
| `fn.type` | 常驻 | `listen`，或 `timer` 加 `every` |
| `fn.outcome` / `terminal` | 结束 | success / error；无外部边时 `terminal: true` |
| `fn.code` + `fn.repo` | 函数 | 仓库内路径:行号；代码块叶子只写行号 |
| `flows` | 每张图 | 至少一条；步骤 from → to 必须在 edges 上 |
| `issues` | 这次不修的疑点 | 写 desc，代码位置可选 |
| `review` | 新节点 | `{ status: draft }`；核对后再改 reviewed |

### 流程怎么写

每张图至少一条流程，只看步骤也能读懂。

- `scenario.desc` 写一件具体的事，不写“用户下单”。
- `title` 用业务话；关键步写 `result`。跨服务步写 `data` 和 `sample`。
- 不跳步。分支走哪条，用 `result` 说明；`when` 写在边上，不写在步骤上。
- 子图用 `refines: <父图id>.<流程id>`。每步 `from` → `to` 必须在 `edges` 里，否则 `step-edge`。
- 失败、超时、回滚另写一条；心跳和定时巡检用 `kind: background` 加 `period`。
- 后台流程写 `period`。它不要求步骤从上一颗小球连续走到，但仍要求每步落在边上。

### 说明文档

每个有子图的节点写 `<节点文件夹>/docs/<id>.md`，挂到 `kb`。新节点和图一起提交。改节点时先读旧文档，改受影响的段落，并重写“怎么做的”，不要追加改动记录。父图上的描述变了，父文档一起改。

## 画函数图（执行图）的规则

图里有 `kind: function` 就按执行图校验。角色优先级是 `outcome` > `check` > `trigger` / `serves` > 普通步骤。提交前对一遍：

| 角色 | 怎么写 | 规则 |
| - | - | - |
| 入口 | `fn.trigger` 或 `fn.serves` | 图内不能有入边（`exec-entry`）。图外调用方可以连进来。同图 `mode: go` 拉起的协程不写 trigger。 |
| 步骤 | 都不写 | 要有图内出边，或用 `call` / `send` 连外部（`exec-dead-end`）。`type: listen` / `timer` 可以没有出边。 |
| 闸门 | `fn.check` | 至少两条出边。`when: pass` 加 `when: fail`（失败也可只标 `error: true`），或每条写条件文字。 |
| 结束 | `fn.outcome` | 不能再连图内节点（`end-exit`）。要有连到外部的边，或 `fn.terminal: true`。 |

常见写法：

- 一个启动函数拉起多个协程：只有启动函数写 `trigger`；连到协程的边写 `kind: call, mode: go`；协程不写 trigger。
- 做完还要交给图内下一个函数：不写 `outcome`。
- 错误边走进成功结束时写 `swallow: 原因`。
- `issues.code` 的仓库：函数用 `fn.repo`，组件用自己的 `repo`。
- 从入口走不到的函数是 `exec-reachable`：补来自入口侧的边，或它由图外调起就写 `fn.trigger`。

有 error 的提案不能停在 `review_gate`。用 `extend` 一次改完。`changes` 冲突时 `replaceChanges: true`；无法收敛就 `discard_change_set`，说明编号、标题和原因。

## 每次提交前自查

- 最后一次 `propose_change_set` 没有 error。警告能修就修，修不了写入 `ignore` 并写原因。
- B3 的每个入口都有归属，或有排除原因。异步消费者和定时任务没有静默漏掉。
- 每张图至少一条流程，步骤都在边上，子流程 `refines` 对得上。
- 每个有子图的节点挂了说明文档，内容和主流程一致。
- 函数有 `fn.code` + `fn.repo`；代码块叶子只写行号。链路 data 有 `repo` + `code`，或 `missing`。
- `repo.local` 来自 `scan_repo_entrypoints` 或 `Where the user is`，不是猜的。
- 名字用业务话，函数名放 `brief`。
- 是否已有 2～4 条左→右业务列、单列 ≤ 4 节点、全图 ≤ 12 节点？
- 调用方、存储、外部系统是否用 `dock` 隔离？
- `name` 是否控制在 2～6 个中文字，关键边是否写了简短动词 `name`？
- 同一提案里的父图、子图、`links.yaml`、`docs` 一起通过。不要留一份半截草稿。
- 交付前再对一次 B3：扫到的入口数 = 已画入流程的入口数 + 写明原因的排除数。差 1 也要补，不能用“主要入口已画”交差。

## 审核点

`review_gate` 的 summary 只讲架构和逻辑：怎么切的、每块做什么、流程是否讲得通、唯一的分歧点。校验问题在停下前改完；提案还有 error 时 gate 会被拒绝。

| 档位 | 停下 |
| - | - |
| `fast` | 不停。交付时附蓝图摘要。 |
| `balanced` | 只停一次：C 的蓝图表格（阶段：蓝图）。 |
| `deep` | 蓝图 → L0 → 模块拆分 → 之后每拆完一批函数。 |

用户通过就按该档位继续。用户改了切分或流程，改完后只在 `deep` 再停一次；`balanced` 把意见吃进同一次交付，不再加停。
