# dsh-lean-preset（「轻量」预设）

给 DSH 加一个**极简**预设：把官方 `minimal` 模式原样留下，只补两件它缺的核心能力 —— **自动压缩** 与 **读图**。

- 模型看到的工具只有两个：`bash`（官方 minimal 的常驻 shell）和 `read_image`。
- 系统提示词只有一句话（minimal 原本的样子）。
- **压缩策略跟随系统**：本包不写死任何触发比例，用 DSH 自己的默认值，并且可以按机器单独调节。
- 图片模态可用：截图、图表直接读，不用先转成文字。

实测请求固定开销（本机 opencode-go/deepseek-v4.1-flash，见 `budget.json`）：

| 预设 | 工具 | 系统提示词 | 合计 |
|---|---|---|---|
| `standard` | 5,146 tok（26 个工具） | 1,443 tok | **≈ 6,589 tok** |
| **`lean`「轻量」** | **311 tok（2 个工具）** | **12 tok** | **≈ 322 tok** |

口径与 DSH 自己的估算器一致（4 字符 ≈ 1 token，含 `contextBreakdown` 的同样偏差）；这是**请求固定开销**，不含对话历史 —— 历史才是大头上限，也正是压缩要解决的那部分。压缩没触发时是 0 成本。

## 特性

- **常驻开销约 standard 的 5%**，并且工具少到不会发生「选错工具」。
- **自动压缩，策略由系统决定**：`compaction-basic` 的每个字段都留给 DSH 自己的默认值（当前 harness 默认 `thresholdRatio 0.8` / `retainRatio 0.16` / `headroomTokens 65536`），本包一个比例都不写死，所以 DSH 升级改了默认值，这个预设跟着走。
- **可以按机器改**：两个环境变量只作用于本预设，见下一节；改完重启 `dsh web`，不用重装、不用改 bundle。
- **`/compact`** 手动压缩，`tool-result-pruner` 在压缩前先裁剪超大工具输出。
- **`read_image`**：PNG/JPEG/WebP/GIF，自动降采样。
- **后台长任务**：用常驻 shell 的 `nohup ... &` + `tail/grep` 轮询（见下），不需要额外工具。
- **与 `dsh-compaction-tune`（「高性能」）并存**：本包不碰 `agent-preset-registry`，也不读它的 `HARNESS_COMPACTION_*`，两个预设各调各的。

## 改压缩策略（分发之后在任意机器上）

本预设使用**系统默认**压缩策略。**本机和别的机器一样**：不设就是系统默认，什么都不用做；
想让某台机器用别的触发点，改那台机器的 `$DSH_HOME/.env` 即可，只影响「轻量」：

```sh
printf 'HARNESS_LEAN_COMPACTION_THRESHOLD_RATIO=0.2\nHARNESS_LEAN_COMPACTION_RETAIN_RATIO=0.02\n' >> ~/.dsh/.env
# 然后重启 dsh web
```

包内自带一个小脚本，写入 + 打印实际生效的数字（推荐，省得记名字）：

```sh
node ~/.dsh/profiles/web/node_modules/dsh-lean-preset/scripts/set-compaction.mjs --show
node ~/.dsh/profiles/web/node_modules/dsh-lean-preset/scripts/set-compaction.mjs --threshold 0.2 --retain 0.02
node ~/.dsh/profiles/web/node_modules/dsh-lean-preset/scripts/set-compaction.mjs --unset
```

两个变量的含义：

| 变量 | 含义 | 不设时 |
|---|---|---|
| `HARNESS_LEAN_COMPACTION_THRESHOLD_RATIO` | 触发点比例，`0 < r ≤ 1`；实际触发 = `min(contextWindow × r, contextWindow − maxTokens − headroom)` | 用系统默认 `0.8` |
| `HARNESS_LEAN_COMPACTION_RETAIN_RATIO` | 压缩后保留的原文尾部占比（相对 `contextWindow − maxTokens`），必须小于触发比例 | 用系统默认 `0.16` |

两个都可以单独设，没设的那个继续用系统默认。填错（非数字、越界、保留 ≥ 触发）时：用 `set-compaction.mjs` 会在**写盘之前**拒绝并给出修正建议；手改 `.env` 则由 `compaction-basic` 在启动时报错并说明是哪个变量（那时这个预设会挂载失败，改回或删掉该行即可）。

**本机当前生效值**（`opencode-go/deepseek-v4.1-flash`，1M 上下文 / 384K 输出预留）：

| 设置 | 触发 | 保留 |
|---|---|---|
| 不设（系统默认 0.8 / 0.16） | 550,464（headroom 上限先到，不是比例） | 98,560 |
| `HARNESS_LEAN_COMPACTION_THRESHOLD_RATIO=0.2` | 200,000 | 98,560 |
| `=0.2` + `RETAIN=0.02` | 200,000 | 12,320 |

（`dsh-compaction-tune` 的 `HARNESS_COMPACTION_THRESHOLD_RATIO=0.4` 只影响「高性能」，不影响本预设。）

## 工作原理

预设 = 官方 `minimal` 声明 + 两块从官方 `standard` 声明**原样复制**的行 + 一个本包自带的小插件：

| 组件 | 作用 |
|---|---|
| `persona` / `persistent-shell` | 与 `minimal.patch.yml` 逐字相同（`complete: true`、无 runtime context） |
| `compaction` 组 | 复制 `standard` 的压缩组（`compaction-basic` + `command-compact` + `tool-result-pruner`），只把 `compaction-basic` 的 config 换成一个读环境变量的 `!!js` 表达式：两个变量都没设时它返回空对象，于是每个字段都落到 harness 默认值 |
| `tool-fs` | 复制 `standard` 的**整个**文件系统行 |
| `tool-gate` | 本包自带插件：在**每个 agent 自己的 context** 上 `tools.restrict({ deny: ['read','write','edit'] })` |

为什么需要 `tool-gate`：`read_image` 和 `read`/`write`/`edit` 同属一个插件行 `@deepseek-ai/dsh-tool-fs`，它没有「只挂 read_image」的开关，也没有子路径导出。所以只能整行挂载，再把不要的三个**按 agent 隐藏**。被隐藏的工具连它自己的提示词段一起消失（官方文件系统工具的说明是可见性门控的），所以模型那里只剩 `bash` 和 `read_image`。

`tool-gate` 的三条触发时机（都是幂等的）：`agent/created`（常规路径：建会话时就选了预设）、`agent/inbox/claimed`（预设是事后挂到已存在的空白会话上时，这一条仍在组装之前）、`agent/pre-step`（兜底，只能纠正下一个请求）。它在空闲时不注册任何工具或提示词，成本为 0。

## 安装

```sh
dsh plugin --profile web add github:KamitobiHaru/dsh-lean-preset#v0.2.0
# 装完重启 dsh web
```

也可以用 Web 的插件页安装（插件 → 安装 → 填上面的 spec），或者本地目录：`dsh plugin --profile web add /path/to/dsh-lean-preset`。

装好后：**新会话的 Coding Tools 选择器里会出现「轻量」**（Settings → General 里 Coding Tools 必须为开，否则新任务界面不显示选择器）。选它即可；这是唯一需要做的选择。

想让某台设备默认用它，把下面四行加进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（用户层最后应用，会盖住其它 bundle 的默认值）：

```yaml
- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: lean
    selectedDefault: lean
```

## 使用

**后台长任务**（没有 `run_in_background`，用 shell 自己解决）：

```sh
nohup ./long-build.sh > /tmp/build.log 2>&1 & echo started
tail -n 20 /tmp/build.log      # 之后轮询
grep -n error /tmp/build.log
```

常驻 shell 的说明里已经写明了这个用法；不要在前台等长命令（默认 300s 超时）。

**加一个工具集（例如不隐藏任何 fs 工具）**：编辑 `scripts/lib.mjs` 里的 `MASK_VARIANTS`，加一项（`key` / `name` / `description` / `deny`），然后 `node scripts/sync.mjs`。每一项都会变成选择器里的一张卡 —— 这就是「启动时人手动挑工具」的粒度。

## 自测

```sh
node scripts/sync.mjs                    # 从已安装的 DSH 重新生成 cordis.patch.yml（幂等）
node scripts/verify.mjs                  # 29 项断言：生成物、上游逐行一致、gate 行为、表达式取值表
node scripts/check.mjs                   # 上游漂移检测（minimal/standard 的 sha256 + dsh 版本）
node scripts/set-compaction.mjs --show    # 这台机器实际生效的压缩策略
node scripts/measure.mjs --preset lean    # 读会话日志，打印实测请求开销
```

`verify.mjs` 里的关键断言：除了明确列出的改动，`minimal` 的每一行都与安装目录里的 `presets/minimal.patch.yml` **深相等**；压缩组与 `tool-fs` 行与 `presets/standard.patch.yml` 深相等；**表达式里没有任何比例字面量**、不读别的 bundle 的环境变量、不设变量时解析出来就是 harness 默认值；`gate` 的 `deny` 名单都是 `@deepseek-ai/dsh-tool-fs` 真实注册的工具名；`budget.json` 里工具恰好是 `bash` + `read_image` 且总开销 ≤ 400 tok。

## 维护与发版

- **上游漂移**：DSH 升级后先跑 `check.mjs`；若 `minimal`/`standard` 变了，`sync.mjs` 会重新生成，`git diff` 就是这次升级带来的差异。若官方改了 bash 的「后台运行」那段描述，`sync.mjs` 会直接报错并指出要找的原文（`DESCRIPTION_EDITS`），改完再同步，不会静默漏掉。
- **压缩默认值**：本包不记录 harness 的默认比例，`verify.mjs` / `set-compaction.mjs` 每次都从已安装的 `dsh-compaction-basic` 源码里读，所以 DSH 换默认值时这两个脚本的输出自动跟着变。
- **发版约定**：`package.json` 的 `version` 与 tag 同名（例如 `0.2.0` ↔ `v0.2.0`），README 的安装 spec 用同一个 tag。

## 卸载

```sh
dsh plugin --profile web remove dsh-lean-preset
```

然后删掉 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里用过的 `agent-preset-registry` 覆盖（如果加过），以及 `~/.dsh/.env` 里的两个 `HARNESS_LEAN_COMPACTION_*`（如果设过）。已创建的会话记录里仍留着 `lean` 这个预设名，重新装回即可继续。

## 已知限制

- **只有两个工具**。`read`/`write`/`edit` 只是被隐藏（插件仍挂载），所以想要回它们只需改 `MASK_VARIANTS` 的 `deny`。
- **`complete: true` 的取舍继承自 minimal**：identity 段、`@路径` 规则、Web 文件链接规范、Web surface 说明、harness source 说明都不出现在提示词里（合计约 666 tok）。这是「一句话提示词」的代价；要保留就把它改成 `complete: false`。
- **压缩策略的粒度是「整个预设」**：一个预设只能有一套策略（该预设的每个会话都用它），不能按会话切换。要两套策略就出两个预设（`MASK_VARIANTS` 那套机制同样适用）。
- **环境变量在启动时读取**：改完 `~/.dsh/.env` 必须重启 `dsh web`；正在跑的会话不受影响。
- **没有后台任务工具 / 子 Agent / 联网检索**（这是刻意的）：后台用 `nohup` + 轮询；子 Agent 与联网各要多约 900 / 230 tok 的 schema 与说明，而且都会让工具目录变「吵」。需要时按「加一个工具集」的办法加。
- **`read_image` 需要当前模型路由声明图像输入**（本机 `opencode-go` 的四个模型都声明了）。切到未声明的模型时它会明确报错 `model "..." does not declare image input`。
- **`tool-gate` 的时序**：常规建会话路径上限制在第一次请求前就位；如果是「先建空白会话、再挑预设」，由 `agent/inbox/claimed` 在组装前补上，`agent/pre-step` 兜底 —— 兜底那次只能纠正下一个请求。
- **子 Agent 不在 gate 范围内**（`scope: root`）。本预设没有子 Agent，所以不影响；如果以后加了，`scope: all` 可以一起隐藏。
- 请求开销按 DSH 的 4 字符/token 估算，CJK 会低估；数字用于横向比较，不是账单。

## License

MIT © 2026 KamitobiHaru
