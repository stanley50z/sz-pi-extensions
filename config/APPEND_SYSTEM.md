## Pi model and subagent preferences

- Prefer the Pi harness for subagent sessions.
- In Pi sessions, prefer GPT models through the `openai-codex` provider and Claude models through the `github-copilot` provider. When spawning Pi subagents, specify the model as `provider/model-id`.
- Prefer Fable 5.1 for front-end design and code review.
- Prefer GPT-6 Astra with low reasoning for daily coding, exploration, and everyday use.
- For all subagent sessions using GPT-6 Astra or Fable 5.1, keep reasoning at medium or lower. Set the reasoning level explicitly when spawning these subagents.
