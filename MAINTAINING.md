# 维护说明（维护者向）

> **本仓库已废弃，停止维护。** DSH 0.2.1 的官方 `minimal` 预设已自带 `read_image` 与自动压缩，
> 本包当初存在的两个理由都不成立了，因此不再发版。下文描述的是最后一个可用版本（`v0.2.1`）
> 与随后的 0.2.1 适配改动（改用上游原生逐工具开关、删除自带 `tool-gate` 插件），
> 供追溯与参考。

面向改这个仓库的人，不是给安装者的。用户文档见 [README.md](README.md) / [README.zh.md](README.zh.md)。

本包的全部产物由脚本从**已安装的 DSH**里读出并生成，仓库里不记录上游的副本：

```sh
node scripts/sync.mjs                    # 从已安装的 DSH 重新生成 cordis.patch.yml（幂等）
node scripts/verify.mjs                  # 断言生成物、上游逐行一致、掩码合法性、表达式取值
node scripts/check.mjs                   # 上游漂移检测（minimal/standard 的 sha256 + dsh 版本）
node scripts/set-compaction.mjs --show    # 这台机器实际生效的压缩策略
node scripts/measure.mjs --preset lean    # 读会话日志，打印实测请求开销
```

脚本都是零依赖 ESM，直接 `node` 跑；`verify.mjs` 末尾的压缩策略表默认按 `web` profile 取值，换 profile 加 `--profile <name>`。

## `verify.mjs` 断言清单

断言清单，关键部分：

- 除了明确列出的改动，`minimal` 的每一行都与安装目录里的 `presets/minimal.patch.yml` **深相等**。
- 压缩组与 `tool-fs` 行与 `presets/standard.patch.yml` 深相等；`compaction-basic` 的 config 只被换成读两个环境变量的 `!!js` 表达式。
- **表达式里没有任何比例字面量**、不读别的 bundle 的环境变量（`HARNESS_COMPACTION_*` / `DSH_COMPACTION_*`）、不设变量时解析出来就是 harness 默认值。
- 掩码是**上游真实的** `@deepseek-ai/dsh-tool-fs` Config：被关掉的工具根本不会注册，而不是「挂载后再隐藏」。
- 预设**不挂任何本包自带的插件** —— 掩码用的是上游开关，没有 `tool-gate` 之类的私有插件。
- `budget.json` 里工具恰好是 `bash` + `read_image`，总开销 ≤ 400 tok。
- 两版 README 都带当前版本的安装 spec、都提到 `read_image` 与 `nohup`、都有升级小节；两版都不得出现维护者向内容；两版 `##` 标题数相等（防双语漂移）。

## 上游漂移

DSH 升级后先跑 `check.mjs`；若 `minimal`/`standard` 变了，`sync.mjs` 会重新生成，`git diff` 就是这次升级带来的差异，读一遍再提交。

若官方改了 bash 的「后台运行」那段描述，`sync.mjs` 会**直接报错**并指出要找的原文（`scripts/lib.mjs` 里的 `DESCRIPTION_EDITS`），改完再同步 —— 不会静默漏掉一段已经过时的说明。

`upstream.json` 只是给 `check.mjs` 对照用的快照（`dshVersion` + 两个 patch 的 sha256），每次同步后刷新。内容没变时 `sync.mjs` 会保留原来的 `generatedAt`，所以空跑一次同步不会弄脏工作区 —— 发布前可以用它自检幂等（`sync.mjs` 后 `git diff --stat` 必须为空）。

## 压缩默认值从哪来

本包**不记录** harness 的默认比例：`verify.mjs` / `set-compaction.mjs` / `measure.mjs` 每次都从已安装的 `@deepseek-ai/dsh-compaction-basic` 源码里读默认值，所以 DSH 换默认值时这些输出自动跟着变。本包的表达式只读两个自有变量：

| 变量 | 含义 |
|---|---|
| `HARNESS_LEAN_COMPACTION_THRESHOLD_RATIO` | 触发点比例，`0 < r ≤ 1`；实际触发 = `min(contextWindow × r, contextWindow − maxTokens − headroom)` |
| `HARNESS_LEAN_COMPACTION_RETAIN_RATIO` | 压缩后保留的原文尾部占比（相对 `contextWindow − maxTokens`），必须小于触发比例 |

本机观察值（仅供参照，`opencode-go/deepseek-v4.1-flash`，1M 窗口 / 384K 输出预留，headroom 65536）：

| 设置 | 触发 | 保留 |
|---|---|---|
| 不设（系统默认 0.8 / 0.16） | 550,464（headroom 上限先到，不是比例） | 98,560 |
| `THRESHOLD=0.2` | 200,000 | 98,560 |
| `THRESHOLD=0.2` + `RETAIN=0.02` | 200,000 | 12,320 |
| `THRESHOLD=0.001` + `RETAIN=0.000125` | 1,000 | 77 |

## 工作原理（实现细节）

预设 = 官方 `minimal` 声明 + 两块从官方 `standard` 声明**原样复制**的行：

| 组件 | 作用 |
|---|---|
| `persona` / `persistent-shell` | 与 `minimal.patch.yml` 逐字相同（`complete: true`、无 runtime context） |
| `compaction` 组 | 复制 `standard` 的压缩组（`compaction-basic` + `command-compact` + `tool-result-pruner`），只把 `compaction-basic` 的 config 换成一个读环境变量的 `!!js` 表达式：两个变量都没设时它返回空对象，于是每个字段都落到 harness 默认值 |
| `tool-fs` | 复制 `standard` 的整个文件系统行，但 config 换成上游的**逐工具开关**：`read: false, readImage: true, write: false, edit: false` |

### 为什么用上游的逐工具开关

`read_image` 与 `read`/`write`/`edit` 同属 `@deepseek-ai/dsh-tool-fs`。DSH 0.2.1 起这个插件的 Config
带逐工具布尔开关（`read` / `readImage` / `write` / `edit`），关掉的工具**根本不会注册**，
也就不会进模型可见的工具目录。

0.2.1 之前没有这个开关，只能整行挂载、再由本包自带的 `tool-gate` 插件在**每个 agent 自己的
context** 上 `tools.restrict({ deny: ['read','write','edit'] })` 把不要的三个隐藏掉。官方
`minimal` 现在自己就用这套开关（`read: false, readImage: true, write: false, edit: false`），
所以 `tool-gate` 已被删除，本包不再自带任何插件。

`budget.json` 是 `measure.mjs --write-budget` 从真实会话日志里量出来的请求固定开销：`bash` 854 字符 / 214 tok，`read_image` 389 字符 / 97 tok，系统提示词 46 字符 / 12 tok，合计 322 tok（DSH 自己的 4 字符 ≈ 1 token 估算器，CJK 会低估）。**该测量基于 DSH 0.2.0-rc.2，早于 0.2.1**；本包已废弃，不再重测。

## 加一个工具集（换掉开关）

编辑 `scripts/lib.mjs` 的 `MASK_VARIANTS`，加一项（`key` / `name` / `description` / `deny`），然后 `node scripts/sync.mjs`。每一项都会变成选择器里的一张卡 —— 这就是「启动时人手动挑工具」的粒度。`verify.mjs` 会按 `MASK_VARIANTS` 逐项校验，不用另写测试。

## 发版约定

- `package.json` 的 `version` 与 tag 同名（例如 `0.2.1` ↔ `v0.2.1`）。
- 两版 README 的安装 spec 用同一个 tag；改文档也要一起发布，否则用户装 `#旧tag` 看到的还是旧文档。
- 发布前：`sync.mjs` 后 `git diff` 必须为空（除非本次确实改了生成物），`check.mjs` 无漂移，`verify.mjs` 全绿。
- 推送：`git push -u origin main && git push origin v<version>`。

> **本仓库已停止按此约定发版。** 以上仅为历史归档的说明。
