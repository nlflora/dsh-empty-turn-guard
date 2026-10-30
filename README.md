# dsh-empty-turn-guard

兜住一类**空回合**：模型整轮只产出思考（reasoning），既没有正文、也没有调用任何工具，而 agent 循环把它当作正常完成收尾——界面上只有一个思考气泡，标记「已完成」，一个字没输出。

插件监听 `agent/turn-stopping`，用**纯结构判断**认出这种轮次，然后往同一轮里 `steer` 一条提示，让循环再走一步。

## 它治的是什么

在 216 个会话、13758 条 assistant 消息里统计到的 49 例「只有思考、没有输出」，按结束原因分：

| 结束原因 | 数量 | 说明 |
| --- | --- | --- |
| `max-tokens` | 16 | 思考把输出额度（4096）吃光，还没轮到写正文 |
| `aborted` | 14 | 用户中断 |
| `completed` | 11 | **正常结束但零输出** ← 本插件的主要目标 |

其中「思考退化」有两种典型形态，都是模型侧的重复循环：

```
… **writing** ✅. Let me go. Hmm — **the tool call** ✅. Let me go. Hmm — the script ✅. Hmm — go.
… 做。 做。 做。 做。 做。 做。 做。 做。 做。 做。 做。 做。 做。 …
```

DSH 看到「没有工具调用、也没有文本」，判定模型已经给出最终答复（空），按 `completed` 收尾。它无法区分「模型认为不需要回答」和「模型卡死了说不出话」。

## 与 dsh-loop-continue 的区别

`dsh-loop-continue` 治的是相邻但不同的问题：模型**写了**「现在我重新应用修改」却忘了调用工具。它的两条硬门槛是：

1. 结束在**只有文本**的 step；
2. 本回合**此前至少调用过一次工具**。

本插件的场景**两条都不满足**（一个字都没有，首次 step 就卡死也可能），所以另起一个。

另一个差别：`dsh-loop-continue` 需要一个裁判模型判 true/false（因为「这句话是不是承诺了动作」是主观判断）；本插件是三个布尔值就能定的结构判断，**不产生额外的模型调用**。

## 安装

```sh
dsh plugin --profile <profile> add @nlflora/dsh-empty-turn-guard
```

本地开发：

```sh
dsh plugin --profile <profile> add link:/path/to/dsh-empty-turn-guard
```

## 配置

在 profile 的 `cordis.patch.yml` 里按 id `empty-turn-guard` 覆盖：

```yaml
- id: empty-turn-guard
  config:
    enabled: true
    maxContinuations: 2        # 每轮最多补救几次
    minReasoningChars: 40      # 思考少于这个字数就不管
    detectRepetition: true     # 是否检测重复退化
    repetitionMinRepeats: 6    # 同一短语连续重复多少次算退化
    assumedMaxOutputTokens: 4096
    debug: false
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `maxContinuations` | `2` | 每轮最多补救次数，防止无限循环 |
| `minReasoningChars` | `40` | 思考太短视为「模型就是选择不回答」，不干预 |
| `detectRepetition` | `true` | 是否做重复检测（只影响日志里的原因标注） |
| `repetitionMinRepeats` | `6` | 判定退化的重复次数阈值 |
| `assumedMaxOutputTokens` | `4096` | 判断是否撞到输出上限 |
| `steerText` | 内置 | 常规补救提示，可整段替换 |
| `steerTextCapped` | 内置 | 撞到输出上限时的提示（要求压缩思考） |
| `debug` | `false` | 打印每次判定 |

## 判定规则

**要补救**，必须同时满足：

1. 本轮没有非空 `text` 块；
2. 本轮没有 `tool-call` 块；
3. 本轮至少有一条 assistant 消息；
4. 思考文字 ≥ `minReasoningChars`。

不满足任何一条就放行，让回合正常结束。正常的「只调用工具不说话」的 step 有 `tool-call`，不会被误伤。

## 它不做什么

- **不改模型行为**。重复退化是模型侧的问题，插件只能事后补救一次，不能保证下一次不犯。
- **不调裁判模型**，所以也不增加 token 消耗。
- **不处理 `aborted`**：用户主动中断的轮次不该被自动续上。

## License

MIT
