# 局部调整与节点下钻

只改用户点名的节点及其父图、子图、说明文档。先读代码和现有图，再提交。必须同时生效的改动放进**同一个提案**。字段与校验以 `common/guide.md` 和 `create/` 模板为准。

改完后用 `show_on_map` 点亮改过的节点；有流程变化时选中对应 `flow`，让用户能直接播放。

## 先读后改

1. `read_node` 读目标节点、父图，以及进出边上的邻居。有子图再读子图。
2. 用 `read_node_code` 核对 `fn.code` 指向的代码。符号或调用关系不清时用 `lsp_symbols`、`lsp_references`（行、列从 1 起）。地图和代码不一致时以代码为准。
3. 边看边 `show_on_map`：打开当前图，点亮正在看的节点；讲一条过程时选中对应 `flow`。
4. 节点已有 `docs/<短id>.md` 时先 `read_file`。改图必须同时改这份文档里受影响的段落；父图上对它的连线、流程或描述变了，父节点文档也要改。不要只在末尾追加“新增了 xx”。
5. 不确定这条线现在校验是否通过时，用 `check_library` 看该节点的现有 error，再决定是修图还是修提案。不要凭旧报错继续改。

## 四种高频操作

### 1. 单节点下钻

把叶子或粗粒度模块拆成子图时，同时扫该节点代码里的同步入口（HTTP / RPC / IPC / CLI）、异步消费（MQ / Kafka / Watch）和定时 / 常驻协程（Cron / Ticker / Goroutine）。三件一起补：

- `<节点目录>/<短id>.yaml`：子节点全局 id 为 `<父id>.<短id>`。函数写 `fn.repo` + `fn.code`；函数内部代码块只写行号。
- `links.yaml`：对外接口与读写的数据各一条，`data` 写 `repo` + `code`。
- `docs/<短id>.md`：按 `create/node-doc-template.md`，挂到 `kb`。

对齐父图：父图进出这个节点的 `call` / `send` 要在子图画出（`edge-mutual`）；子图连到外部的边要能在父图找到同方向、同错误标记的边，且 `via` 不能多出父图（`edge-lift`）。每条子流程写 `refines: <父图id>.<流程id>`，进出本节点的步骤顺序与父流程一致（`flow-refines`）。

下钻一层只拆一层。L1 保持 `kind: component` 的职责块，并在 `brief` 写对应入口；用户没有明确要函数级执行图时，不要铺 `kind: function`。只有用户点名要执行图，且这块本身就是一两个函数时，才画函数图。

同时整理排版，不要只把节点塞进去：主链路保持 2～4 条左→右命名 `lanes`，单列 ≤ 4、全图 ≤ 12。调用方、公共依赖、图外系统、存储分别用 `dock: left` / `top` / `right` / `bottom`。`name` 收成 2～6 个中文字，关键边补 2～6 字动词 `name`。`lanes.name` 会显示成层标题，写成简短中文。

### 2. 拆分 / 合并节点

拆分或合并要连带更新父图的 `contains`、`lanes`、`edges`、`flows`，以及父子 `docs/*.md`。这些文件必须在同一个 `propose_change_set` 里：先提交得到 id，后续用 `extend: <id>`。只改一半会因 `edge-lift`、`edge-mutual` 或 `flow-refines` 卡住。

合并时删掉被合并节点在父图、泳道、连线和流程里的引用，把它的入出边接到保留下的节点。不要留下指向已删除 id 的步骤。

拆成子目录后，子节点文件名用短 id，全局 id 仍是 `<父id>.<短id>`。父图 `contains` 改成这个子 id，或在子图里引用外部邻居 `{ ref, path }`。`path` 相对当前 YAML 所在目录。

### 3. 补漏分支、异步流、存储连线

先对上真实行号再写 `fn.code`，不要凭记忆补一条边。

- 判断写成闸门：`fn.check`，至少两条出边，每条写 `when`；异常边加 `error: true`。错误被吞掉并走到成功结束时写 `swallow: 原因`。
- 同图里 `go` / 线程拉起的函数不写 `trigger`，启动边用 `kind: call` 或 `send` 加 `mode: go` 或 `thread`。
- 定时写 `fn.type: timer` 和 `fn.every`；监听、Watch、channel 写 `fn.type: listen`。它们没有下游也不算死路。
- 公共中间件先搜已有 `resource`，用 `{ ref, path }` 复用。不要再建一个 Redis / MQ。读写边写 `via`，指向已有或本次补的链路。
- 新分支补进 `flows` 时，每步 `from` → `to` 都要已有边。非后台流程不能跳步；缺的中间节点按最短路径补进步骤，否则 `step-reached`。

### 4. 修复坏提案

历史提案的 `changes` 互相冲突，或用户从「Fix with AI」点进来时，先用 `check_library` 看报出的规则，再对根因改一次干净提案。不要在错误列表上继续 `extend` 叠补丁，也不要留下校验失败的草稿。

- 还能保留这个编号：`extend: <id>` 并传 `replaceChanges: true`，用一份收敛后的 `changes` 覆盖旧列表。同路径的 `files` 本来就会覆盖。
- 整份草稿已经写乱：`discard_change_set({ id, reason })`，再提一份干净提案。告诉用户丢弃的编号、标题和原因。修完后提案里不能再留 error。

## 提交

一次 `propose_change_set` 只写一两个文件，用 `extend` 合并。这张图没写完不要中途修校验。全部写完后，按最后一次回复把 error 一次改完。修不了的警告写进对应节点的 `ignore` 并说明原因。

交给用户的只讲改了哪段逻辑、哪条流程现在怎么走。不把校验报错交给用户判断。提案仍有 error 时不要结束这一轮。
