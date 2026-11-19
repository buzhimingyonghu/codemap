# Codemap v1 速查

写 YAML 前对照本页。字段全集以 `create/node-template.yaml`、`create/link-template.yaml` 为准；这里只列会直接变成校验错误的硬规则。

## 文件布局与 ID

- 一目录一个主节点：`<文件夹>/<短id>.yaml`，同目录放 `links.yaml`，说明放 `docs/<短id>.md`，用 `kb: [{ title: 说明, url: docs/<短id>.md }]` 挂上。
- 每个节点文件和链路文件都写 `schema: codemap/v1`。
- 没有 `nodes/` 目录时，加载器递归读整个库，按内容区分：有 `requirement` 是需求，同时有 `owner` 和 `links` 是链路，其余是节点。需求放 `requirements/<id>.yaml`。
- 全局 id 用 `.` 分段，每段匹配 `[A-Za-z0-9][A-Za-z0-9_-]*`。就地节点、链路、data、流程的短 id 不能再带 `.`；全局 id 必须是 `<父id>.<短id>`。
- 顶层 id 带 `.` 时，前缀必须已是节点（`id-prefix`）。先有父节点，再写子节点。
- `id` 全局只能定义一次（`id-unique`）。链路 id 是 `owner.<短id>`，data id 是 `owner.<短id>`；多条链路传同一份结构体时写 `ref`，不要再定义一遍。
- `kind` 只用 `project` / `component` / `sdk` / `resource` / `function`。存储和中间件用 `resource`。链路和数据类型不要写成节点，只放在 `links.yaml`。
- 节点必填 `name`。`resource` 的 `resource` 字段与探索脚本给出的名字一致（`redis` / `etcd` / `kafka` / `mysql` / `s3`）。

## 仓库与相对路径

- `repo` 与 `fn.repo` 都是 `{ remote, local }`。`remote` 必填（git 远端或模块路径）。`local` **相对当前这份 YAML 所在目录**，不是相对库根；空值会报 `repo-local`，绝对路径只会警告。
- 层数用系统提示 `Where the user is`，或 `scan_repo_entrypoints(path, targetFolder)` 返回的相对路径。禁止凭感觉写 `../../`。
- 函数仓库只写在 `fn.repo`，和 `fn.code` 放一起。写到节点顶层 `repo` 会报 `code-repo`。组件上的 `repo` 只说明对应哪个仓库，不参与拼路径。
- `fn.code` 写仓库内相对路径加行号，如 `internal/service/order.go:120-158`。禁止绝对路径和 `..`。行号从 1 起，结束 ≥ 开始。
- 函数内部的代码块叶子只写行号，如 `42-68`，不再写 `repo`。文件和仓库用外层那个写了路径的函数。外层没有文件或仓库时报 `code-format` / `code-repo`。
- 不写 `repo.dir`。以前写在 `dir` 里的前缀直接拼进 `code`。只写文件不写行号只是 info，打开的是整个文件。
- `kb.url` 只能是 `http(s)` 或文件路径。说明文档用相对本 YAML 目录的路径，如 `docs/<短id>.md`。

## 四类函数角色

角色只由 `fn` 推出，优先级是 `outcome` > `check` > `trigger` / `serves` > 普通步骤。`fn.type` 只影响显示，不改变角色。图里只要有 `kind: function`，就按执行图校验。

| 角色 | 写法 | 硬校验 |
| - | - | - |
| 入口 | `fn.trigger` 或 `fn.serves` | 至少一个入口（`exec-entry`）。图内不能有入边；入边来自同图节点时，去掉 trigger/serves，改成普通步骤。图外调用方连进来可以。同图用 `mode: go` 或 `thread` 拉起的协程不写 `trigger`。 |
| 步骤 | 上述都不写 | 要有图内出边，或用 `kind: call` / `send` 连到外部。`next` 连外部不算出口，否则 `exec-dead-end`。`type: listen` 或 `timer` 的常驻循环除外；`timer` 必须写 `fn.every`（`500ms` / `3s` / `1m`）。 |
| 闸门 | `fn.check` | 至少两条出边，图内或连外部都算（`gate-branches`）。要么 `when: pass` 再加一条 `when: fail`（失败也可只标 `error: true`），要么每条都写条件文字。异常边标 `error: true`。 |
| 结束 | `fn.outcome: success` 或 `error` | 不能再连图内节点（`end-exit`）。必须有连到外部的边，或写 `fn.terminal: true`。错误结束的出口应标 `error: true`（`return` 除外）；成功结束不要标 `error`。 |

从入口沿图内边走不到的函数报 `exec-reachable`：补入边，或它确实由图外调起就写 `fn.trigger`。入口只连外部、自己有 `contains`、或这张图里全是入口，不算死路。错误边走进 `outcome: success` 又没写 `swallow: 原因`，会警告 `error-swallowed`。

`trigger` 只接受 `grpc` / `http` / `tcp` / `mq` / `cron` / `func`。`serves` 必须指向 `links.yaml` 里的链路 id。写了 `serves` 后，输入输出从链路取，`fn.io` 可以不写。

`fn.outcome` 同时存在时角色就是结束，`check` 和 `trigger` 不再另算角色。不要在同一个函数上既写 `outcome` 又指望它当闸门。

## 连线、流程、链路

- `contains` 三种：子 id 字符串、`{ ref, path }`（path 相对本 YAML 目录）、就地对象（只写短 id）。连线两端都必须在 `contains` 里（`edge-endpoint`）。
- `edges.kind`：`next`（默认）/ `call` / `send` / `return`。`mode: go` 或 `thread` 只能写在 `call` 或 `send` 上。同一对节点多条线必须写 `id`（`edge-unique`）。
- 有 `edges` / `flows` / `lanes` 就必须有 `contains`。每张图至少一条有步骤的 `flows`。
- 流程步骤的 `from` → `to` 必须落在已有边上；沿 `call` 的反向也算（`step-edge`）。非后台流程不能跳步（`step-reached`）。`when` 写在边上，不写在步骤上。
- `links.yaml` 的 `owner` 必须是已有节点。每份 `data` 写 `repo` + `code`；找不到定义就只写 `missing: 原因`。跨服务边写 `via`，指向链路 id。
- `via` 是链路 id，多条写列表，不能是空列表。`protocol` 用 `http` / `grpc` / `tcp` / `mq` / `func` / `sql` / `redis`。mq 不写 `dir: response`。
- 连线上不写 `signal` / `period`（`edge-heartbeat`）。周期写到链路的 `heartbeat: true` 或 `3s`。流程小球的 `signal` 才写 `data` / `ack` / `error` / `heartbeat`。
- 下游不是 `resource` 时，`via` 里至少一条链路的 owner 应是下游或其上层，否则警告 `edge-unmatched`。投递到 MQ / etcd 或从它们收消息不查这条。

## 跨图三条铁律

- **`edge-mutual`**：A 图有 `call` / `send` 的 `A → B`，且 B 自己的图里已经有边，则 B 图必须用 `{ ref, path }` 引用 A（或其上层，或 A 里面的节点）并画出同方向的边。两边都写了 `via` 时，B 侧合起来要盖住 A 这条线的 `via`。`next` 不查。自己没画边的分类框不查。
- **`edge-lift`**：子图连到外部节点的边，在每个能看到该外部节点的父图上必须有对应边，方向和是否 `error` 一致。子图的 `via` 不能多出父图同一对节点上的 `via`。
- **`flow-refines`**：子流程写 `refines: <父图id>.<流程id>`。父图必须包含或引用本节点。进出本节点的步骤按顺序与父流程一致。每步 `from` → `to` 还必须存在于 `edges`（`step-edge`）。

父图看不到子图连出去的那个外部节点时，是警告 `edge-orphan`，不是 error。`return` 边不参与 `via` 的父子对照。

## 架构图视觉层级规范

L0 和 L1 按同一套排版。`lanes.name` 会画成泳道底框和层标题，所以必须是简短中文层名。

- 主链路按请求或数据流向拆成 **2～4 条左→右命名泳道**（如 `接入层` → `核心编排` → `领域服务` → `下游/通知`）。不要把多个模块塞进一条 `biz` 列。
- `dock`：调用方 / 触发源 `left`，配置 / 注册 / 鉴权 / 公共依赖 `top`，第三方或图外通知目标 `right`，DB / Redis / MQ / 对象存储 / 日志 `bottom`。
- 单条业务列 ≤ 4 个节点；单张图核心业务节点 ≤ 8，含 dock 全部 ≤ 12。超出先按域聚合成模块。
- `name` 用 2～6 个中文字。`brief` 写 3～10 字技术定位。关键边写 2～6 字动词 `name`（`创建订单`、`锁定库存`、`发布事件`）。
- L0 只放调用方、服务模块、外部系统、存储。L1 只放 `kind: component` 职责块。`kind: function` 只在用户点名单个节点或 `deep` 时出现。

## 提案

- 多文件用 `propose_change_set`：一次一两份，之后 `extend: <id>` 并进同一提案。同一路径的 `files` 会覆盖旧文本。这张图没写完不要中途修。
- 全部写完后，看最后一次回复，一次 `extend` 修完所有 error。警告能修就修；修不了写 `ignore: { 规则名: 原因 }`。
- `extend` 里的 `changes` 是往旧列表上叠加。互相矛盾时传 `replaceChanges: true`，用本次列表覆盖旧变更，不要在坏列表上再打补丁。
- 整份草稿无法收敛：`discard_change_set({ id, reason })`，并向用户说明丢弃的编号、标题和原因。不要把坏草稿留在会话里。
- 一个提案放一张图的 yaml、`links.yaml`、`docs`。拆节点和改父图必须一起生效，放进同一个提案。有 error 时不要调 `review_gate`。
