---
description: Wipe the claude-dejavu cache. Pass `--tool <ToolName>` to scope the wipe to one tool.
argument-hint: "[--tool <ToolName>]"
---

Run the Bash tool with this exact command and print the output verbatim, without summarising or interpreting it:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" clear $ARGUMENTS
```
