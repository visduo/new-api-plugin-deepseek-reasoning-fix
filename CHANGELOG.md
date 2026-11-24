---
changelogVersion: 1
plugin: "visduo_deepseek-reasoning-fix"
version: "1.0.1"
locale: "en"
translations:
  zh-CN: CHANGELOG.zh-CN.md
---
# Changelog

## [1.0.1]

### Fixed

- Use JSON Patch `copy` operations for existing reasoning text and combine longer conversations into one `replace /messages`, so the plugin result no longer repeats large reasoning content per message and adds less latency.
