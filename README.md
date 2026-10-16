# dsh-devlog

DSH 插件：在每轮工作结束时，自动把这一轮的上下文加工成一段开发日志，追加到本地文件。

开发者每天写完代码就忘了写日志。这个插件替你记——今天干了什么、为什么这么干、踩了什么坑。

## 定位

- 面向开发者本人的开发日志，不是 CHANGELOG，不是会话摘要
- 读者只有开发者自己
- 验证"上下文 + 记忆 + 检查点 → 自动总结"这套机制在 DSH 生态里跑不跑得通

生态位上，dsh-memory 类负责"记"（输出给 Agent 的记忆片段），dsh-git-commit 类负责"提交"，dsh-trail-plugin 类负责"找"。这个插件填的是空缺的那一环：把上下文和记忆里的技术讨论，加工成面向开发者本人的开发日志。

## 闭环

```
agent/turn-stopping → 切片过滤本轮事件 → 模型判断/生成 → 追加落盘
```

1. 监听 `agent/turn-stopping`（serial 钩子，只观察不 steer）
2. 从 `session/event` 订阅缓冲切出本轮事件，过滤噪音（系统消息、plugin/skill-catalog 注入、request/header、session/title 等）
3. 调模型（deepseek-flash）把材料加工成第一人称开发日志；没有实质内容模型输出 SKIP，不写
4. 追加写入 `$DSH_HOME/devlog/YYYY-MM-DD.md`，每段以二级标题开头，不写日期（日期由外层统一加），只追加不重写

## 项目位置

本仓库（clone 后的目录）是独立项目目录，代码、依赖、测试全在这里。

插件本身不在 `$DSH_HOME` 下，DSH 主目录只被读取、不被污染：挂载靠 `--patch <仓库目录>/cordis.patch.yml`。

注意：主 `cordis.patch.yml` 里 `name` 用的是**包名** `dsh-devlog-auto`（不是绝对路径），因此通过 `dsh plugin add dsh-devlog-auto` 或桌面端插件管理器安装后可直接解析，跨机器无需改路径。只有 `tests/` 下的两个探针 patch 仍写绝对路径——它们是本地开发工具，不随 npm 包发布（见 `files` 字段），clone 到别的机器重跑探针时才需要改。

## 目录结构

```
dsh-devlog/  （仓库根目录）
├── index.js          # 插件主逻辑（监听/切片过滤/生成/落盘）
├── cordis.patch.yml  # patch 层，一行 insert（name 为包名 dsh-devlog-auto）
├── package.json      # type: module
├── node_modules/     # 依赖：schemastery 3.18.4（volatile 字段必需）
├── prompts/
│   ├── system.md     # 系统提示词初始默认值（可在设置页改，见下）
│   └── task.md       # 任务提示词模板（{{date}} 等变量）
├── tests/
│   ├── probe1/       # 探测 1：挂 turn-stopping，dump 事件载荷结构
│   └── probe2/       # 探测 2：确认 prepareCall 形态 + source 字段 + volatile 配置
└── README.md
```

## 安装 / 本地挂载

```bash
cd <仓库目录>
npm install          # 装本地依赖（开发用）

# 作为 DSH 插件安装（已发布到 npm）：
npm install dsh-devlog-auto
```

跑 DSH 时挂上（把路径换成你 clone 下来的仓库目录）：

```bash
dsh --profile headless --patch <仓库目录>/cordis.patch.yml "<你的任务>"
```

或把 `cordis.patch.yml` 里的 insert 行合并进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 常驻。

## 依赖说明：为什么 schemastery 是硬依赖

`@deepseek-ai/schemastery` 被**固定锁死为 `3.18.4` 的 `dependencies`**，而没有按生态惯例放进 `peerDependencies`，原因是：

设置页可编辑的 `logPrompt` 依赖 schemastery 的 `.volatile()`（3.18.4 才提供），而 DSH 宿主内置的是 3.18.2，没有 volatile。若改成 peer 依赖并回落到宿主版本，`logPrompt` 会退化成普通字符串——默认值仍在（日志照样生成），但**设置页编辑能力会丢失**。

所以这里刻意保留硬依赖。代价是与"由宿主统一提供 schemastery"的生态惯例不一致，安装时 pnpm 可能打出 peer warnings，属预期行为，不影响运行。

重跑探测脚本（改插件 API 用法前值得先跑一遍确认形态）：

```bash
dsh --profile headless --patch <仓库目录>/tests/probe2/cordis.yml "回复：probe-ok"
```

## 输出目录

默认是 `$DSH_HOME/devlog/`（即 `~/.dsh/devlog`，DSH 默认家目录），符合"插件把产物写进 DSH 主目录"的语义。

想让产物也离开 DSH 主目录，就在设置页填 `outputDir`（例如 `$DSH_HOME/devlog` 或任意你指定的绝对路径）——留空则用默认。运行时日志和 debug dump 会跟着一起走。

## 设置页可配置项

系统提示词不写死在文件里，模型与调试选项也都走 Config（均可在设置页改）：

```js
Config: {
  logPrompt: z.string().default(<prompts/system.md 内容>).volatile(),  // 系统提示词（volatile，可热改）
  blocking: z.boolean().default(true),                  // 阻塞开关
  provider: z.string().default('deepseek-official'),    // 生成模型 provider
  model: z.string().default('deepseek-flash'),          // 生成模型名
  reasoningEffort: z.string().default('low'),           // 思维链强度（low/high；flash 无 none）
  debugDump: z.string().default('on-error'),            // 调试材料落盘：always / on-error / off
  outputDir: z.string().default(''),                    // 日志目录；留空 = $DSH_HOME/devlog
}
```

- `logPrompt`：在 DSH 设置页的插件卡片里编辑，保存后生效；生成时用 `config.logPrompt.get()` 读当前值。已知限制：host（cordis 4.0.2）不识别 volatile，改配置保存后会重启插件（新值生效，非无感热替换）。`prompts/system.md` 是这个字段的**初始默认值**。
- `provider` / `model` / `reasoningEffort`：生成用的模型与思维链强度。默认 deepseek-flash + low，日志加工足够；换模型/档位按需改。
- `debugDump`：调试材料（喂给模型的完整上下文 + 原始事件）落盘策略。
  - `always`：每轮都写 `.devlog-context-debug.txt`（含你的代码/工具回显，**默认不开启**）
  - `on-error`：仅生成失败/异常时写，便于排查（默认）
  - `off`：从不写
  - 文件落在日志目录下，不在意可定期删。

## blocking 开关

- `blocking: true`（默认）：轮次关闭前等日志写完，headless 模式下产物必然落盘
- `blocking: false`：立即放行轮次，生成在后台跑。交互模式延迟低，但进程退出可能丢未完成的生成

## 运行时日志与调试产物

都在 `$DSH_HOME/devlog/` 下：

- `.devlog-runtime.log` —— 每次跳过/生成/落盘/报错，含材料长度、裁剪档位、生成耗时，排查首选
- `.devlog-context-debug.txt` —— 每次喂给模型的**完整材料** + 原始事件结构 dump（每轮覆盖）

第二个文件的价值：**看不到材料就是盲飞**。第一版曾经因为字段名解析错位，让模型只拿到一条用户指令在凭空写日志（材料 133 字符），产物全是编的——靠这个 dump 才抓出来。调提示词时也值得对着它看。

注意：这个文件里是完整轮次内容（含文件正文、工具回显），不在意的话可以定期清掉。

## 时间基准（踩过的坑）

轮次材料里会带当天更早的日志段（`{{existing_log_today}}` 用于避免重复）。模型容易把这些更早段落误当成"昨天写的"，进而写出"昨天我说过……"这种带偏时间基准的句子。

`prompts/task.md` 顶部专门写了一段时间澄清：已有日志是今天更早写的、早先段落里的"昨天"是相对今天而言、引用时段必须基于材料里真实对应的时间段。别删这一段。

## 第一版不做

- 时间戳分段触发
- 手动全量收口覆盖
- PPT 输出
- 扣子 Skill 那条线
