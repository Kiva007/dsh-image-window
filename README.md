# dsh-image-window

DSH 图片滑动窗口：每个 agent 步骤的模型请求前，把**最近 N 个 assistant 步骤之外**的图片块标记 offloaded——治理 computer-use 截图在上下文里的无限累积。

## 解决什么问题

- computer-use 插件（@copylee/dsh-computer-use）的截图作为 attachment 内联进会话后永远留在历史里，且每轮请求全量重编码重发（dsh-llm-pi-ai 源码注释：*"Every image in history is re-encoded into every request body"*）。
- DSH 唯一的自动清理（@deepseek-ai/dsh-compaction-image-offload）只在请求图片总量爆 20MiB（IMAGE_OFFLOAD_REQUIRED）时兜底 offload 最旧 N 张——不到闸就一路攒着（实测：23 张截图把上游 ack 拖过 60s deadline）。
- compaction 只压文字不压图；插件自身的 ui_elements/文本通道能少产图，但产了的图没有回收机制。

## 做法

只追加 `image/offload` 事件（与官方插件**完全相同**的数据形状），渲染全复用官方链路：

1. 本插件在 `agent/pre-step` 瀑布里扫描 surface，选出窗口外的图片出现，`session.append('image/offload', { targets })`；
2. dsh-compaction-image-offload 注册的投影把事件折叠为 `block.offloaded = true`（同步生效，下一步请求即可见）；
3. dsh-llm 构建请求时把这些块投影为占位符文本，带本地只读路径（`Normalized copy (read-only...): <path>`），模型需要时可用 `read_image` 按路径读回。

本插件**不注册自己的消息投影**（同 type 重复注册会抛错），也因此强依赖 dsh-compaction-image-offload 同在（dsh-base bundle 内置，默认启用）；缺它时对本会话停摆并记一次 warn。

## 阈值语义（keepSteps，默认 2）

从 surface 末端向前数，`assistant/message` 节点计一个"步骤"；位于最近 keepSteps 个步骤**之外**的 `user/message` / `tool/result` 节点里的图片块（且尚未 offloaded）全部进 targets，一次 append 一个事件。

- keepSteps=2：只保留最后两轮动作的截图，更早的变占位符；
- keepSteps=0：当前步之外的图全部立刻 offload（最激进）；
- assistant 节点的图片永不选（投影校验 target 类型）；
- 幂等：已 offloaded 的块跳过，无新目标不 append；compaction 换掉旧节点后自然看不到。

## 安装（桌面 profile，link 方式）

```jsonc
// C:/Users/K - Sir/.dsh/profiles/desktop/package.json
"dependencies": { "...", "dsh-image-window": "link:D:/files/DSH/dsh-image-window" },
"dsh": { "profile": { "bundles": ["...", "dsh-image-window"] } }
```

node_modules 联接（junction，无需管理员）：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE.dshprofilesdesktop
ode_modulesdsh-image-window" -Target "D:ilesDSHdsh-image-window"
```

**新包装机必须完整重启 Desktop**（托盘退出再开；插件行热挂载不适用于新包）。

## 调阈值

改 `cordis.patch.yml` 里 insert 条目的 `config.keepSteps`，保存后完整重启 Desktop。

## 验证

- 跑单测：`node --test test/`（桩会话复刻 surface API，覆盖窗口选择/幂等/assistant 跳过/缺投影停摆）；
- 实战：重启后开一个 computer-use 会话连点几步，会话日志里应出现 `image/offload` 事件；请求体里旧截图位置变成占位符文本（带路径）。

## 卸载

从 profile package.json 的 dependencies 与 bundles 移除 `dsh-image-window`，删掉 node_modules 联接，完整重启。历史会话里已有的 `image/offload` 事件在重放时仍需要 dsh-compaction-image-offload 在场（与官方插件同口径）。
