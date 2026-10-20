# dsh-lean-preset（「轻量」预设）

[English](README.md) | 中文

## 已废弃

**本项目已废弃，停止维护。** DSH 0.2.1 的官方 `minimal` 预设已经自带了这个包当初要补的两项能力：

- **读图** —— 官方 `minimal` 现在挂载 `@deepseek-ai/dsh-tool-fs` 时带 `read: false, readImage: true, write: false, edit: false`，`read_image` 开箱可用。上游同时长出了**原生的逐工具开关**，也就是这个包原来用自带的 `tool-gate` 插件模拟的东西。
- **自动压缩** —— 官方 `minimal` 现在自带 `compaction` 组（`compaction-basic` + `/compact` 命令）。

两件事都成了上游的事，本包就没有可贡献的了，不再发版。

**改用什么：**

- 官方 `minimal` 预设 —— 同样的两个工具，用系统自己的压缩默认值。
- [`dsh-compaction-tune`](https://github.com/KamitobiHaru/dsh-compaction-tune) 的 **「高性能精简」**（`high-performance-minimal`）预设 —— 同样的极简工具面，但压缩策略可以用环境变量调。

本文其余部分描述的是最后一个可用版本（`v0.2.1`），保留作参考。

## 它曾经是什么

给 DSH 加一个**极简**预设：把官方 `minimal` 模式原样留下，只补两件它当时缺的核心能力 —— **自动压缩** 与 **读图**。

- 模型看到的工具只有两个：`bash`（官方 minimal 的常驻 shell）和 `read_image`。
- 系统提示词只有一句话（minimal 原本的样子）。
- **压缩策略跟随系统**：本包不写死任何触发比例，用 DSH 自己的默认值，并且可以按机器单独调节。
- 图片模态可用：截图、图表直接读，不用先转成文字。

请求固定开销（在 `deepseek-v4.1-flash` 上测得，口径与 DSH 自己的估算器一致：4 字符 ≈ 1 token，含 `contextBreakdown` 的同样偏差）：

| 预设 | 工具 | 系统提示词 | 合计 |
|---|---|---|---|
| `standard` | 5,146 tok（26 个工具） | 1,443 tok | **≈ 6,589 tok** |
| **`lean`「轻量」** | **311 tok（2 个工具）** | **12 tok** | **≈ 322 tok** |

这是**请求固定开销**，不含对话历史 —— 历史才是大头上限，也正是压缩要解决的那部分。压缩没触发时是 0 成本。

## 安装

```sh
dsh plugin --profile web add github:KamitobiHaru/dsh-lean-preset#v0.2.1
# 装完重启 dsh web
```

也可以用 Web 的插件页安装（插件 → 安装 → 填上面的 spec），或者装本地目录：`dsh plugin --profile web add /path/to/dsh-lean-preset`。

装好后：**新任务界面的「Agent 预设」选择器里会出现「轻量」**（设置 → 通用设置里的「显示代码工作视图」必须为开，否则新任务界面不显示这个选择器）。选它即可；这是唯一需要做的选择。

想让某台设备默认用它，把下面四行加进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（用户层最后应用，会盖住其它 bundle 的默认值）：

```yaml
- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: lean
    selectedDefault: lean
```

## 它给你什么

- **常驻开销约 standard 的 5%**，并且工具少到不会发生「选错工具」。
- **自动压缩，策略由系统决定**：`compaction-basic` 的每个字段都留给 DSH 自己的默认值（当前 harness 默认 `thresholdRatio 0.8` / `retainRatio 0.16` / `headroomTokens 65536`），本包一个比例都不写死，所以 DSH 升级改了默认值，这个预设跟着走。
- **可以按机器改**：两个环境变量只作用于本预设，见下面的「改压缩策略」；改完重启 `dsh web`，不用重装、不用改 bundle。
- **`/compact`** 手动压缩，`tool-result-pruner` 在压缩前先裁剪超大工具输出。
- **`read_image`**：PNG/JPEG/WebP/GIF，自动降采样。
- **后台长任务**：用常驻 shell 的 `nohup ... &` + `tail/grep` 轮询（见下），不需要额外工具。
- **与「高性能」「高性能精简」（`dsh-compaction-tune`）并存**：本包不碰 `agent-preset-registry`，也不读它的 `HARNESS_COMPACTION_*` 变量，各预设各调各的。

## 工作原理

预设 = 官方 `minimal` 声明 + 两块从官方 `standard` 声明**原样复制**的行：

- 文件系统行由**上游自带**的 `@deepseek-ai/dsh-tool-fs` 逐工具开关遮蔽：`read: false, readImage: true, write: false, edit: false`。关掉的工具根本不会注册，所以模型那里只剩 `bash` 和 `read_image`。（DSH 0.2.1 之前这一行没有这种开关，本包得自带 `tool-gate` 插件按 agent 隐藏多余的工具；上游的原生开关取代了它。）
- 压缩组照抄 `standard`，只把 `compaction-basic` 的 config 换成读两个环境变量的表达式：都没设时它返回空对象，于是每个字段都落到 harness 默认值。
- 与上游逐行一致由 `scripts/verify.mjs` 保证（`minimal` 必须除声明的改动外与安装目录里的 `presets/minimal.patch.yml` 深相等）。

实现细节、断言清单和上游漂移处理见 [MAINTAINING.md](MAINTAINING.md)。

## 改压缩策略

本预设使用**系统默认**压缩策略：不设就是系统默认，什么都不用做。

想让某台机器用别的触发点，改那台机器的 `$DSH_HOME/.env`（默认 `~/.dsh/.env`）即可，只影响「轻量」：

```sh
printf 'HARNESS_LEAN_COMPACTION_THRESHOLD_RATIO=0.2\nHARNESS_LEAN_COMPACTION_RETAIN_RATIO=0.02\n' >> ~/.dsh/.env
# 然后重启 dsh web
```

包内自带一个小脚本，写入并打印实际生效的数字（推荐，省得记名字）：

```sh
node ~/.dsh/profiles/web/node_modules/dsh-lean-preset/scripts/set-compaction.mjs --show
node ~/.dsh/profiles/web/node_modules/dsh-lean-preset/scripts/set-compaction.mjs --threshold 0.2 --retain 0.02
node ~/.dsh/profiles/web/node_modules/dsh-lean-preset/scripts/set-compaction.mjs --unset
```

（profile 名不是 `web` 时，把路径里的 `web` 换成你的。）

两个变量的含义：

| 变量 | 含义 | 不设时 |
|---|---|---|
| `HARNESS_LEAN_COMPACTION_THRESHOLD_RATIO` | 触发点比例，`0 < r ≤ 1`；实际触发 = `min(contextWindow × r, contextWindow − maxTokens − headroom)` | 用系统默认 `0.8` |
| `HARNESS_LEAN_COMPACTION_RETAIN_RATIO` | 压缩后保留的原文尾部占比（相对 `contextWindow − maxTokens`），必须小于触发比例 | 用系统默认 `0.16` |

两个都可以单独设，没设的那个继续用系统默认。填错（非数字、越界、保留 ≥ 触发）时：用 `set-compaction.mjs` 会在**写盘之前**拒绝并给出修正建议；手改 `.env` 则由 `compaction-basic` 在启动时报错并说明是哪个变量（那时这个预设会挂载失败，改回或删掉该行即可）。

一个例子（1M 上下文、384K 输出预留的路由；下表里 `THRESHOLD` / `RETAIN` 指上面两个变量，别的模型按同一公式变）：

| 设置 | 触发 | 保留 |
|---|---|---|
| 不设（系统默认 0.8 / 0.16） | 550,464（headroom 上限先到，不是比例） | 98,560 |
| `THRESHOLD=0.2` | 200,000 | 98,560 |
| `THRESHOLD=0.2` + `RETAIN=0.02` | 200,000 | 12,320 |

## 使用

**后台长任务**（没有 `run_in_background`，用 shell 自己解决）：

```sh
nohup ./long-build.sh > /tmp/build.log 2>&1 & echo started
tail -n 20 /tmp/build.log      # 之后轮询
grep -n error /tmp/build.log
```

常驻 shell 的说明里已经写明了这个用法；不要在前台等长命令（默认 300s 超时）。

## 升级

本包不保存任何自己的数据，升级就是「用新 tag 覆盖旧的，然后重启」：

```sh
dsh plugin --profile web add github:KamitobiHaru/dsh-lean-preset#v0.2.1
# 装完重启 dsh web
```

同一条依赖会被更新，bundle 保持在 `dsh.profile.bundles` 里，**不需要先卸载**。

升级不会动这三样：

- `$DSH_HOME/.env` 里的 `HARNESS_LEAN_*`（只在启动时读，换版本不影响）；
- profile patch 里你自己加的 `agent-preset-registry` 覆盖（把「轻量」设为默认的那几行）；
- 已建会话记录里的预设名 `lean`：旧会话照常打开，不用迁移。

版本变化：

| 版本 | 变化 |
|---|---|
| `0.1.0` | 首个版本；压缩默认 `0.4` / `0.05`，并读取共用的 `HARNESS_COMPACTION_*` 变量 |
| `0.2.0` | 压缩改用系统默认策略，并只读上面两个 `HARNESS_LEAN_*` 变量 |
| `0.2.1` | 文档：中英双 README、升级与卸载说明；运行行为无变化 |

## 卸载

```sh
dsh plugin --profile web remove dsh-lean-preset
```

然后删掉 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里用过的 `agent-preset-registry` 覆盖（如果加过），以及 `~/.dsh/.env` 里的两个 `HARNESS_LEAN_*`（如果设过）。已创建的会话记录里仍留着 `lean` 这个预设名，重新装回即可继续。

## 已知限制

- **只有两个工具**。`read`/`write`/`edit` 由上游 `tool-fs` 的开关直接关掉（不再挂载），把 `scripts/lib.mjs` 里的开关改回来再重新生成即可要回，见 [MAINTAINING.md](MAINTAINING.md)。
- **`complete: true` 的取舍继承自 minimal**：identity 段、`@路径` 规则、Web 文件链接规范、Web surface 说明、harness source 说明都不出现在提示词里（合计约 666 tok）。这是「一句话提示词」的代价；要保留就把它改成 `complete: false`。
- **压缩策略的粒度是「整个预设」**：一个预设只能有一套策略（该预设的每个会话都用它），不能按会话切换。要两套策略就出两个预设。
- **环境变量在启动时读取**：改完 `~/.dsh/.env` 必须重启 `dsh web`；正在跑的会话不受影响。
- **没有后台任务工具 / 子 Agent / 联网检索**（这是刻意的）：后台用 `nohup` + 轮询；子 Agent 与联网各要多约 900 / 230 tok 的 schema 与说明，而且都会让工具目录变「吵」。
- **`read_image` 需要当前模型路由声明图像输入**。切到未声明的模型时它会明确报错 `model "..." does not declare image input`。
- **名字不参与翻译**：「轻量」这个名字和描述在任何界面语言下都是中文 —— DSH 只翻译它自带的 standard / minimal / creator，自定义预设的 `name` / `description` 逐字显示。英文界面里请认这张中文卡片。
- 请求开销按 DSH 的 4 字符/token 估算，CJK 会低估；数字用于横向比较，不是账单。

## License

MIT © 2026 KamitobiHaru

---

维护本仓库：[MAINTAINING.md](MAINTAINING.md)
