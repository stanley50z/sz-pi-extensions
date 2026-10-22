## Pi model and subagent preferences

- Prefer the Pi harness for subagent sessions.
- In Pi sessions, prefer GPT models through the `openai-codex` provider and Claude models through the `claude-bridge` provider. Native Claude Code is an alternative for Claude subagents. When spawning Pi subagents, specify the model as `provider/model-id`.
- If `openai-codex` fails due to usage limits, retry OpenAI model requests through the `azure-foundry` provider.
- Prefer Opus 5.5 with high reasoning for front-end design, code review, daily coding, exploration, and everyday use.
- For all subagent sessions using Opus 5.5, explicitly set reasoning to high.
