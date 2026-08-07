<div align="center">

# Night Foundry（夜铸）

**写 spec、过验证、直接交付——一气呵成**

信任交付，而不是演示——交给它一份 spec，拿回一份验证过的 diff。

[English](./README.md) · 简体中文

**[关于](#关于) · [快速上手](#快速上手) · [工作原理](#工作原理) · [恢复与批处理](#恢复批处理与取证) · [为什么做它](#为什么做它) · [能力边界](#能力边界) · [参考](#参考) · [许可证](#许可证)**

</div>


## 关于

Night Foundry（npm 包名 `nightfoundry`）是一个 LLM 编码 agent 的外部管控框架（harness）。模型负责写代码，而所有判定"完成"的检查都在模型之外以纯 JavaScript 运行：scope 契约、硬检查（hard checks）、回归门禁、完整测试套件。任何检查都不会被跳过、被换个说法糊弄过去、或者由模型给自己打分。

它不是一个什么都干的全能 agent。只做一个循环，做到位：spec 进 → 经过门禁验证的交付出。

## 快速上手

前置条件：Node.js 18+、一个你想要修改的 git 仓库（JS 或 Python）、已登录的 Claude Code 或 `ANTHROPIC_API_KEY`。运行会消耗真实的 Anthropic token——小 spec 几美元，大的更多；每次运行后 `cc-orch usage` 会报告花费。

安装：

```bash
npm install -g nightfoundry
```

安装后有两个等价命令：`nightfoundry` 和 `cc-orch`——指向同一个 CLI。下文示例统一使用 `cc-orch`（它沿用已久的名字），你用哪个都行。

<details>
<summary>或者从源码安装</summary>

```bash
git clone https://github.com/VanK33/nightfoundry.git
cd nightfoundry
npm install
npm link
```

</details>

在你想要修改的仓库目录里：

```bash
# 1. 最简单的第一次运行——一次性小改动，不用写 spec
cc-orch task "Add input validation to the /api/users endpoint"
```

cc-orch 会规划、执行、验证，并展示 diff。任何改动都必须先通过 JS 侧的门禁才会落地。

比一句话改动更大的任务，请给它一份 **spec**。两种方式：

```bash
# 2a. 手写一份 .uspec.json——七个字段，无需了解引擎内部：
#     goal, scope_in, scope_out, success_criteria,
#     constraints, assumptions, architecture_notes
cc-orch run my-feature.uspec.json -a    # 手写 uspec 直接运行（dry-run 只对 .md spec 入队）

# 2b. 或者从一句描述生成（交互式问答）：
cc-orch brainstorm "Add rate limiting to all write endpoints"
#   → 提出澄清问题，生成 <slug>.spec.md + <slug>.spec.json
```

然后运行：

```bash
cc-orch dry-run <spec>       # 廉价的安全检查：规划 + 假设校验，不执行
cc-orch run <spec>           # 交互式：确认计划，逐个展示 diff
cc-orch run <spec> -a        # 自动批准（无人值守）
cc-orch resume --batch -a    # 无人值守地清空 dry-run 队列
```

跑完之后你会得到：一份验证过的 diff、一条自动生成的 changelog、按角色拆分的成本明细，以及一个可与未来运行做对比的归档快照。

## 工作原理

```
  spec  →  dry-run  →  run / resume --batch  →  archive
 (要什么) (规划 +      (逐任务执行 + 门禁；      (版本 +
          假设校验；    可恢复；仅需人类         成本；
          入队)        决策时 park)             可对比)
```

编排逻辑完全在模型**之外**。Claude 会话是短生命周期的无状态工人：领一个任务，返回 schema 校验过的 JSON，然后退出。其余的一切——状态、门禁、不变量——都是模型无法覆写的 JavaScript。它是驾驶舱，不是自动驾驶：人拥有决策权，cc-orch 拥有联锁保护。

### 门禁（每一道都是代码，不是提示词）

门禁是模型无法靠话术绕过的检查：它作为普通 JavaScript 在管线的固定节点运行，结果为红就停止运行。十道门禁中有四道承载了核心立场——绿色的运行必须有真实含义：

<!-- 下方四行与 details 块内完整表格中的对应行逐字一致。两处需同步修改。 -->

| 门禁 | 强制执行的规则 |
|---|---|
| **Baseline** | 运行开始前目标仓库的 `test` / `test:all` 不是绿的，就拒绝花钱。 |
| **Phantom-write 检测** | 拒绝那些声称"写入"了文件、磁盘上却没有实际变更的 executor。 |
| **Regression** | 在 mission 和 milestone 两级对照任务前快照做回归；失败则回滚肇事 mission，保留同级任务的成果。 |
| **终局 `test:all` 门禁** | 完整套件不绿就禁止归档（覆盖开关：`cc-orch archive --skip-test-gate`）。 |

<details>
<summary>全部十道门禁及源码位置</summary>

| 门禁 | 强制执行的规则 | 位置 |
|---|---|---|
| **Baseline** | 运行开始前目标仓库的 `test` / `test:all` 不是绿的，就拒绝花钱。 | `src/orchestrator/gates/baseline.js` |
| **Plan-structure lint** | 在任何执行开始前，拒绝违反 mission / milestone / task 结构的 planner 输出。 | `src/orchestrator/gates/plan-structure-lint.js` |
| **Plan-scope lint** | 每个任务必须声明它将触碰的文件；未匹配的 scope 项按配置报错或告警（见 [`--allow-incomplete-scope`](./.claude/skills/cc-orch-operator/references/commands.md)）。 | `src/orchestrator/gates/plan-scope-lint.js` |
| **Scope coverage** | spec 里的每个 scope 项都必须被某个任务覆盖，否则运行中止。 | `src/orchestrator/gates/scope-coverage.js` |
| **Hard checks** | 来自 `verify.json` 的逐任务确定性命令——不通过任务就不前进。 | `src/orchestrator/gates/hard-checks.js` |
| **Regression** | 在 mission 和 milestone 两级对照任务前快照做回归；失败则回滚肇事 mission，保留同级任务的成果。 | `src/orchestrator/gates/regression.js` |
| **Coverage / audit** | 对写入状态做结构性覆盖与审计检查。 | `src/orchestrator/gates/coverage.js`、`audit.js` |
| **Phantom-write 检测** | 拒绝那些声称"写入"了文件、磁盘上却没有实际变更的 executor。 | `src/orchestrator/core/pipeline.js` |
| **Test-registration 熔断器** | 同一个测试注册失败反复出现时，升级给 analyzer 处理，而不是无限重试。 | `src/orchestrator/gates/test-registration.js` |
| **终局 `test:all` 门禁** | 完整套件不绿就禁止归档（覆盖开关：`cc-orch archive --skip-test-gate`）。 | `src/cli/commands/archive.js` |

</details>

每道门禁的设计理由见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

Agent 的输入输出是 **schema 校验的 JSON**，不做 markdown 解析（`src/orchestrator/agents/_schemas.js`）。状态机（`src/orchestrator/core/state-machine.js`）是唯一能改变任务状态的路径。任何门禁处的瞬时 API 故障要么重试、要么让运行保持可恢复——绝不会被记成你的代码失败。

executor 的每次写入在字节落盘前都要经过一个前置写入钩子（`src/orchestrator/infra/session-manager.js`）。路径必须解析到项目根内部、匹配该任务声明的目标文件之一；已存在的文件必须在同一会话中先被 Read 过。正是这个钩子支撑起"模型不能写它没读过的文件"这条保证——它以纯 JavaScript 在模型之外强制执行。

## 恢复、批处理与取证

这条管线的设计目标是：被打断也能存活，失败时留下完整线索：

- **中断安全。** Ctrl-C、API 故障、机器休眠 → 状态已保存。`cc-orch resume` 从断点继续；已完成的工作原封不动。
- **批处理。** `cc-orch dry-run` 把校验过的 spec 入队。`cc-orch resume --batch -a` 无人值守地清队列：每个 spec 隔离运行，失败的 spec 被回滚，队列继续（`cc-orch queue list`）。
- **Park（挂起）。** 当运行撞上只有人能决定的事（spec 假设失败、analyzer 升级、评审被拒），条目会被 **park** 而不是丢弃。`cc-orch park list` 展示在等什么、为什么等；`cc-orch park resolve <slug> --requeue|--waive|--reject` 带着你的决定送它回去。
- **非阻塞告警。** 不值得中止运行的 reviewer 发现会落进台账（`cc-orch warnings list`）。攒够了用 `cc-orch warnings brainstorm <ids>` 批量合成一份修复 spec。
- **归档。** 每次完成的运行归档在 `archives/<id>/`：完整状态、verifier 判定、reviewer 发现、成本明细、HTML 报告（`cc-orch archive show <id> --report`）。跨运行可对比（`cc-orch archive diff a b`、`cc-orch dispersion`）。

## 为什么做它

在一个超长 Claude 会话里跑多步构建，坏法是可预测的：上下文被压缩、状态在管线中途丢失；agent 跳过自己的检查、或者给自己的工作盖"完成"章；token 花费不可见，直到账单来了才知道。

把编排挪到模型之外，你才能得到这个产品主张所依赖的性质：**信任交付，而不是演示。**归档里的每一个绿都是*验证过*的绿（是 JS 门禁说的，不是 agent 自己说的）；每一次失败都留下可行动的取证线索（状态、verifier 输出、快照、reviewer 笔记），而不是一个黑盒。

那些承重的规则——每一条都能溯源到一个带 commit SHA 的真实 bug——写在 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 里。

## 能力边界

**今天就能用：**

- 单 spec 管线端到端：规划 → 执行 → 验证 → 评审 → 归档。
- 多 mission 分解，带并行调度与文件冲突检测。
- mission / milestone 两级回归门禁、保留同级成果的快照回滚、phantom-write 检测。
- 多 spec 批处理队列，无人值守，逐 spec 隔离：失败的 spec 被回滚、队列继续；中断和 API 故障留下的是可恢复的条目，不是损坏的状态。
- 人在环的逃生通道：卡住的条目走 park/resolve，非阻塞发现走告警台账。
- 成本透明：单次运行与跨归档（`cc-orch usage --all`）、按角色拆分。
- 本地 web 仪表盘（`cc-orch ui`）观察运行。

**还不行——别指望：**

- **在任意陌生仓库上冷启动未经证明。**绝大部分锤炼发生在本代码库和少数几个已知的 JS/Python 仓库上。陌生项目的第一次运行会有摩擦。
- **只支持 JS 和 Python。**Go、Rust、重 TS 的项目等未经测试。
- **只支持单仓库。**不支持跨仓 / monorepo workspace。
- 记忆 / architect 层是后续阶段的事。

## 参考

<details>
<summary>完整 CLI</summary>

**Spec 工作流**

```bash
cc-orch task "..."                              # 一次性改动，不用 spec
cc-orch brainstorm "..."                        # 一句描述 → spec 对（交互式）
cc-orch dry-run <spec.md>                       # 规划 + 假设校验，不执行；入批处理队列
cc-orch run <spec.md | spec.uspec.json> [-a]    # 运行 spec（也支持 --spec-stdin 从管道读入 uspec）
cc-orch status [<mission-id>]                   # 进度
```

**批处理与恢复**

```bash
cc-orch resume [--batch] [-a]                   # 恢复被中断的运行 / 清空队列
cc-orch queue list | remove <slug>              # 批处理队列
cc-orch park list | show <slug> | resolve <slug> --requeue|--waive|--reject
cc-orch warnings list | show <id> | resolve <id...> | brainstorm <id...>
```

**归档**

```bash
cc-orch archive [name] [-P|--preserve] [--skip-test-gate]
cc-orch archive list | show <id> [--report] | diff <a> <b>
cc-orch dispersion [<id> | compare <a> <b>]     # 归档指纹
```

**成本与维护**

```bash
cc-orch usage [--detailed | --all | --role <r> | --last <n> | --since <yyyy-mm-dd> | --include-failed]
cc-orch usage compare <a> <b>                   # 跨归档的成本 / token 对比
cc-orch ui [--port N]                           # 本地 web 仪表盘
cc-orch health                                  # 配置与状态完整性检查
cc-orch clean [--force]                         # 清理残留的 .harness/ 状态
cc-orch init [spec.md] | version | help
```

`cc-orch help` 从路由器打印同一份清单。各角色使用的模型可在 `src/orchestrator/infra/config.js` 配置。

</details>

### 全局安全开关

预检覆盖开关——每个都是用一项安全检查换取便利，所以每个开关的作用范围都写明：

| 开关 | 效果 | 适用命令 |
|---|---|---|
| `--allow-dirty` | 跳过工作树必须干净的 git 预检 | `run`、`dry-run` |
| `--no-git-required` | 不要求 git 仓库也继续执行 | `run`、`dry-run` |
| `--allow-incomplete-scope` | planner 标记出无任务匹配的 scope 项时告警而非报错 | `run`、`dry-run`、`resume`、`task` |

### 文档

`cc-orch init` 会把一份面向 AI 的操作手册（`cc-orch-operator` skill）部署进目标仓库的 `.claude/skills/`，让在那里工作的 Claude 会话懂得如何驱动运行、排查问题、编写 spec——手册随引擎一起更新。本 README 没讲透的东西（开关、状态、恢复动词）都在那里有答案；直接问会话就行，它读得到这些文件。它们同时就是文档：

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 管线、门禁，以及每条带 commit-SHA 溯源的结构性规则。
- [`docs/STABILITY-CONTRACT.md`](./docs/STABILITY-CONTRACT.md) — 公开 API 面。
- [`commands.md`](./.claude/skills/cc-orch-operator/references/commands.md) — 权威的命令 / 开关参考。
- [`spec-authoring.md`](./.claude/skills/cc-orch-operator/references/spec-authoring.md) — 手写 spec 契约（六个章节、声明式文件集、验证形状）。
- [`state-layout.md`](./.claude/skills/cc-orch-operator/references/state-layout.md) — 磁盘状态布局（`.harness/`、`queue/`、`archives/`、`refs/park/`）。
- [`gotchas.md`](./.claude/skills/cc-orch-operator/references/gotchas.md) — 需要知道的坑。

### 依赖

`@anthropic-ai/claude-agent-sdk`（拉起 Claude 会话）+ `@anthropic-ai/sdk` + `express` / `node-cron`（webhook 与定时触发）+ 仅开发用的 `@xterm/headless`、`jsdom`。无构建步骤，纯 ESM。

### 测试

`npm run test:all` 运行完整套件（`scripts/run-tests.js`）；单项套件是 `package.json` 里的各 `test:*` 脚本。`npm run audit:r2` 运行文档漂移审计。

## 许可证

[Fair Source](https://fair.io/)，不是开源（open source）：代码以 [Functional Source License 1.1（FSL-1.1-ALv2）](LICENSE.md) 授权——免费使用、阅读、修改、再分发（包括商用与内部使用），只有一条限制：不得用它构建竞争性产品或服务。每个版本发布两年后自动转为 Apache-2.0。
