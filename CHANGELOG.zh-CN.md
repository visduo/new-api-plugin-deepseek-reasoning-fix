---
changelogVersion: 1
plugin: "visduo_deepseek-reasoning-fix"
version: "1.0.1"
locale: "zh-CN"
---
# Changelog

## [1.0.1]

### Fixed

- 已有推理文本改用 JSON Patch 的 `copy` 操作，较长的对话合并为一次 `replace /messages`，插件结果不再逐条重复大段推理内容，降低处理延迟。
