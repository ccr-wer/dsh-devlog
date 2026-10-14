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

**`D:/dsh-devlog/`** —— 独立项目目录，代码、依赖、测试全在这里。

插件本身不在 `$DSH_HOME` 下，DSH 主目录只被读取、不被污染：挂载靠 `--patch D:/dsh-devlog/cordis.yml`（patch 层只是引用一个绝对路径，不往 DSH 里写东西）。

## 目录结构

```
D:/dsh-devlog/
├── index.js          # 插件主逻辑（监听/切片过滤/生成/落盘）
├── cordis.yml        # patch 层，一行 insert（name 指向本项目 index.js）
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
cd D:/dsh-devlog
npm install
```

跑 DSH 时挂上：

```bash
dsh --profile headless --patch D:/dsh-devlog/cordis.yml "<你的任务>"
```

或把 `cordis.yml` 里的 insert 行合并进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 常驻。

重跑探测脚本（改插件 API 用法前值得先跑一遍确认形态）：

```bash
dsh --profile headless --patch D:/dsh-devlog/tests/probe2/cordis.yml "回复：probe-ok"
```

## 输出目录

默认是 `$DSH_HOME/devlog/`（即 `D:/DSH/devlog/`），符合"插件把产物写进 DSH 主目录"的语义。

想让产物也离开 DSH 主目录，就在设置页填 `outputDir`（例如 `D:/dsh-devlog/devlog`）——留空则用默认。运行时日志和 debug dump 会跟着一起走。

## 设置页可编辑的提示词

系统提示词不写死在文件里。插件 Config 声明了一个 volatile 字符串字段：

```js
Config: {
  logPrompt: z.string().default(<prompts/system.md 内容>).volatile(),
  blocking: z.boolean().default(true),
}
```

- 在 DSH 设置页的插件卡片里编辑 `logPrompt`，保存后生效
- 生成时用 `config.logPrompt.get()` 读当前值
- 已知限制：host（cordis 4.0.2）不识别 volatile，改配置保存后会重启插件（新值生效，非无感热替换）

`prompts/system.md` 的作用是这个字段的**初始默认值**：用户没改过就用文件内容，改过就用设置页的值。

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
