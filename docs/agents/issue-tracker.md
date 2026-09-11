# Issue tracker

Use GitHub Issues in `stanley50z/sz-pi-extensions`, resolved from `origin`. Use `gh` from the checkout.

- Publish requirements with `gh issue create --title "..." --body "..."`.
- Read tickets and decisions with `gh issue view <number> --comments`.
- List work with `gh issue list --state open --json number,title,body,labels,assignees`.
- Update requirements with `gh issue edit`; record findings with `gh issue comment`.
- Link implementation PRs with `Closes #<number>` so merge closes the issue.
- A session implementing its own issue must leave off `ready-for-agent`.

PRs as a request surface: no.
