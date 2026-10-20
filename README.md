# dsh-lean-preset

English | [中文](README.zh.md)

## Deprecated

**This project is deprecated and no longer maintained.** DSH 0.2.1's shipped `minimal` preset now provides both capabilities this bundle existed to add:

- **Image input** — the official `minimal` mounts `@deepseek-ai/dsh-tool-fs` with `read: false, readImage: true, write: false, edit: false`, so `read_image` is available out of the box. Upstream also grew a **native per-tool switch**, which is what this bundle used to emulate with its own `tool-gate` plugin.
- **Automatic compaction** — the official `minimal` ships a `compaction` group (`compaction-basic` + the `/compact` command).

Both are now upstream's job, so there is nothing left for this bundle to contribute. No further releases will be made.

**What to use instead:**

- The official `minimal` preset, for the same two-tool surface with the harness's own compaction defaults.
- [`dsh-compaction-tune`](https://github.com/KamitobiHaru/dsh-compaction-tune)'s **「高性能精简」** (`high-performance-minimal`) preset, if you want the same minimal tool surface *plus* a compaction policy you can tune through environment variables.

The rest of this document describes the last release (`v0.3.0`) and is kept for reference.

## What it was

Adds a **lean** agent preset to DSH: the shipped `minimal` preset kept verbatim, plus the two core capabilities it lacked at the time — **automatic compaction** and **image input**.

- The model sees exactly two tools: `bash` (minimal's persistent shell) and `read_image`.
- The system prompt is one sentence (minimal's own).
- **Compaction follows the harness**: no trigger ratio is baked in; DSH's own defaults apply, and each machine can override them.
- Image input works: screenshots and charts are read directly instead of being transcribed first.

The preset's card carries its original Chinese name and description in every UI language — **look for the 「轻量」 card** in the Agent preset picker. DSH translates only its own shipped presets (Standard / Minimal / Creator); a custom preset's `name` and `description` are shown verbatim.

Fixed request overhead (measured on `deepseek-v4.1-flash`, same 4-chars-per-token estimator DSH uses, including the same `contextBreakdown` deviation):

| Preset | Tools | System prompt | Total |
|---|---|---|---|
| `standard` | 5,146 tok (26 tools) | 1,443 tok | **≈ 6,589 tok** |
| **`lean`「轻量」** | **311 tok (2 tools)** | **12 tok** | **≈ 322 tok** |

That is **fixed request overhead**, not conversation history — history is the part that grows, and it is exactly what compaction is for. When compaction has not fired, it costs nothing.

## Install

```sh
dsh plugin --profile web add github:KamitobiHaru/dsh-lean-preset#v0.3.0
# then restart dsh web
```

The Web UI can install it too (Plugins → Install → paste the spec above), or install a local directory: `dsh plugin --profile web add /path/to/dsh-lean-preset`.

Once installed, **the 「轻量」 card appears in the Agent preset picker on the new-task screen** (Settings → General → "Show coding view" must be on, otherwise that picker is hidden). Choosing it is the only decision required.

To make it the default on one machine, add these four lines to `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (the user layer is applied last, so it wins over other bundles' defaults):

```yaml
- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: lean
    selectedDefault: lean
```

## What you get

- **About 5% of `standard`'s standing overhead**, and few enough tools that picking the wrong one is not a failure mode.
- **Automatic compaction, policy decided by the harness**: every `compaction-basic` field is left to DSH's defaults (`thresholdRatio 0.8` / `retainRatio 0.16` / `headroomTokens 65536` today). No ratio is baked in, so an upgrade that changes the default carries this preset along with it.
- **Per-machine overrides**: two environment variables that touch only this preset (see Compaction). Restart `dsh web` afterwards — no reinstall, no bundle edit.
- **`/compact`** for manual compaction, with `tool-result-pruner` trimming oversized tool output before it.
- **`read_image`**: PNG/JPEG/WebP/GIF, downsampled automatically.
- **Long background jobs**: `nohup … &` in the persistent shell plus `tail`/`grep` polling (see below), without a dedicated tool.
- **Coexists with `dsh-compaction-tune`** (the "高性能" and "高性能精简" presets): this bundle never touches `agent-preset-registry` and never reads that bundle's `HARNESS_COMPACTION_*` variables.

## How it works

The preset is the shipped `minimal` declaration plus two rows copied verbatim from the shipped `standard` declaration:

- The filesystem row is masked by the **shipped** `@deepseek-ai/dsh-tool-fs` per-tool switch: `read: false, readImage: true, write: false, edit: false`. The tools that are switched off are never registered, so the model is left with `bash` and `read_image`. (Before DSH 0.2.1 this row had no such switch, and the bundle carried its own `tool-gate` plugin to hide the unwanted tools per agent; upstream's native switch replaced it.)
- The compaction group is copied from `standard`; only `compaction-basic`'s config is replaced with an expression that reads two environment variables. With neither set it returns an empty object, so every field falls through to the harness default.
- `scripts/verify.mjs` enforces the verbatim match: apart from the declared edits, `minimal` must be deep-equal to the installed `presets/minimal.patch.yml`.

Implementation details, the assertion list and upstream-drift handling live in [MAINTAINING.md](MAINTAINING.md).

## Compaction

This preset uses the **harness default** policy: do nothing and you get it.

To give one machine a different trigger point, edit that machine's `$DSH_HOME/.env` (default `~/.dsh/.env`). Only this preset is affected:

```sh
printf 'HARNESS_LEAN_COMPACTION_THRESHOLD_RATIO=0.2\nHARNESS_LEAN_COMPACTION_RETAIN_RATIO=0.02\n' >> ~/.dsh/.env
# then restart dsh web
```

The bundle ships a small script that writes the values and prints the numbers that actually take effect (recommended — no need to remember the names):

```sh
node ~/.dsh/profiles/web/node_modules/dsh-lean-preset/scripts/set-compaction.mjs --show
node ~/.dsh/profiles/web/node_modules/dsh-lean-preset/scripts/set-compaction.mjs --threshold 0.2 --retain 0.02
node ~/.dsh/profiles/web/node_modules/dsh-lean-preset/scripts/set-compaction.mjs --unset
```

(If your profile is not `web`, replace `web` in that path.)

What the two variables mean:

| Variable | Meaning | When unset |
|---|---|---|
| `HARNESS_LEAN_COMPACTION_THRESHOLD_RATIO` | Trigger ratio, `0 < r ≤ 1`; the actual trigger is `min(contextWindow × r, contextWindow − maxTokens − headroom)` | Harness default `0.8` |
| `HARNESS_LEAN_COMPACTION_RETAIN_RATIO` | Share of the original tail kept after compaction, relative to `contextWindow − maxTokens`; must stay below the trigger ratio | Harness default `0.16` |

Either one can be set alone; the other keeps the harness default. If a value is wrong (not a number, out of range, retain ≥ trigger), `set-compaction.mjs` refuses **before writing** and suggests a fix; editing `.env` by hand instead makes `compaction-basic` fail at startup and name the offending variable (the preset then fails to mount — revert or delete that line).

An example (a route with a 1M window and 384K output reservation; `THRESHOLD` / `RETAIN` below stand for the two variables above, and other models follow the same formula):

| Setting | Trigger | Retain |
|---|---|---|
| Unset (harness default 0.8 / 0.16) | 550,464 (the headroom cap binds first, not the ratio) | 98,560 |
| `THRESHOLD=0.2` | 200,000 | 98,560 |
| `THRESHOLD=0.2` + `RETAIN=0.02` | 200,000 | 12,320 |

## Usage

**Long background jobs** (there is no `run_in_background`; the shell solves it):

```sh
nohup ./long-build.sh > /tmp/build.log 2>&1 & echo started
tail -n 20 /tmp/build.log      # poll from here
grep -n error /tmp/build.log
```

The persistent shell's description already documents this recipe; do not wait on a long command in the foreground (300s default timeout).

## Upgrade

The preset stores nothing of its own, so upgrading means installing the newer tag over the old one and restarting:

```sh
dsh plugin --profile web add github:KamitobiHaru/dsh-lean-preset#v0.3.0
# then restart dsh web
```

The same dependency is updated and the bundle stays in `dsh.profile.bundles` — **no uninstall first**.

An upgrade does not touch:

- the two `HARNESS_LEAN_*` variables in `$DSH_HOME/.env` (read at startup only, unaffected by the version);
- your own `agent-preset-registry` override in the profile patch (the lines that make 「轻量」 the default);
- the preset id `lean` recorded in existing sessions: they keep opening normally, nothing to migrate.

Version history:

| Version | Change |
|---|---|
| `0.1.0` | First release; compaction defaulted to `0.4` / `0.05` and read the shared `HARNESS_COMPACTION_*` variables |
| `0.2.0` | Compaction follows the harness defaults and reads only the two `HARNESS_LEAN_*` variables |
| `0.2.1` | Docs: English + Chinese READMEs, upgrade and uninstall sections; no runtime change |
| `0.3.0` | Final release: uses the shipped per-tool switch instead of the bundle-local `tool-gate`, and carries the deprecation notice |

## Uninstall

```sh
dsh plugin --profile web remove dsh-lean-preset
```

Then delete the `agent-preset-registry` override you added in `~/.dsh/profiles/<profile>/cordis.patch.yml` (if any) and the two `HARNESS_LEAN_*` lines in `~/.dsh/.env` (if you set them). Sessions already created still record the preset name `lean`; reinstall and they keep working.

## Known limits

- **Two tools only.** `read`/`write`/`edit` are switched off by the shipped `tool-fs` config; flip the flags in `scripts/lib.mjs` and re-run the generator to get them back — see [MAINTAINING.md](MAINTAINING.md).
- **`complete: true` is inherited from minimal**: the identity section, `@path` rules, Web file-link conventions, the Web surface description and the harness-source note are all absent from the prompt (≈666 tok combined). That is the price of the one-sentence prompt; set `complete: false` to keep them.
- **Compaction policy is per preset**: one preset has one policy, shared by all of its sessions; it cannot switch per session. Two policies means two presets.
- **Environment variables are read at startup**: restart `dsh web` after editing `~/.dsh/.env`; running sessions are unaffected.
- **No background-job tool, no subagents, no web search** (deliberate): background work uses `nohup` + polling; subagents and web search would each add roughly 900 / 230 tok of schema and guidance, and both make the tool catalog noisier.
- **`read_image` needs the current route to declare image input**. On a model that does not, it fails with `model "..." does not declare image input`.
- **The name is not translated**: 「轻量」 and its description stay Chinese in every UI language, because DSH translates only its own shipped presets and shows a custom preset's `name`/`description` verbatim. Look for that Chinese card in an English UI.
- Request overhead uses DSH's 4-character/token estimate, which underestimates CJK; the numbers are for comparison, not billing.

## License

MIT © 2026 KamitobiHaru

---

Maintaining this repo: [MAINTAINING.md](MAINTAINING.md)（中文）
