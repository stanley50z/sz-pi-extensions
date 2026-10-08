# New Sign in with ChatGPT subscription usage reporting

Research date: 2026-10-08. Scope: public documentation, source, and issues for the new direct OAuth grant, `chatgpt.tokens.use.direct`, audience `https://api.openai.com/v1`, followed by live validation through Pi's auth runtime and ChatGPT's usage page. The public-source researcher did not access credentials or browser sessions. Live validation retained only redacted results, never credential values.

## Conclusion

**OpenAI explicitly says programmatic remaining-quota reporting is not currently supported for this flow.** This is stronger evidence than merely failing to find an endpoint.

In [openai/sign-in-with-chatgpt-devkit issue #3](https://github.com/openai/sign-in-with-chatgpt-devkit/issues/3), the question specifically asks about the new direct OAuth grant, remaining subscription quota, per-app quota, reset times, and possible response headers/events. On October 1, 2026, `vignesh-oai`, identified by GitHub as a repository `COLLABORATOR`, [answered](https://github.com/openai/sign-in-with-chatgpt-devkit/issues/3#issuecomment-5936080960):

> This is not supported at the moment. We may build this in the future. The core issue is maintaining consistent reporting across ALL product surfaces where the user has logged in with Sign in with ChatGPT. Inconsistencies can result in user confusion.

The issue is closed. No working direct-OAuth quota endpoint, required extra scope, or special-header solution was found in the bounded searches. This does not prove that private browser APIs do not exist. It establishes that they are not a supported quota-reading contract for this grant.

## Official documentation

- [Accounts and sessions, Tracking usage](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions.md) directs integrations to link to `https://chatgpt.com/settings/usage`. Plus has a five-hour allowance shared across apps. The documented five-hour limit **does not apply to Pro**. The illustrated app settings let users set an app's weekly usage allowance from 10% to 100%; that configured allowance should not be confused with a live percentage consumed.
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md) documents `GET https://api.openai.com/v1/models` and `POST https://api.openai.com/v1/responses`, authenticated with `Authorization: Bearer <access_token>`. HTTP inference requires `store: false` and `stream: true`. It explicitly says to use the public Responses endpoint rather than ChatGPT `backend-api` endpoints for this flow. This page does not document a quota-read endpoint or quota percentage headers.
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery.md) documents `subscription_sharing_usage_limit_exceeded`, HTTP 429, and `subscription_sharing_usage_unavailable`, HTTP 503. The former means pause and link to usage settings. OpenAI specifically says **not to infer entire-plan exhaustion or a reset time** from it because an app-specific limit can apply. These errors can also arrive through `response.failed` after streaming starts. They are not a substitute for a quota meter.
- [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference.md) specifies audience `https://api.openai.com/v1` and opaque `per_user_salt` / `encrypted_auth_metadata` claims. It does not expose quota percentages or an account-ID claim that clients should extract from that opaque metadata.
- The [official devkit source](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/0a36fefeb913055c8c7a1a29b63d82b96b2e841a/packages/local/src/index.ts) exports `CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage"`, consistent with the documented link-out approach.

## Public implementations

### OpenClaw deliberately excludes this grant from quota fetching

[OpenClaw `extensions/openai/usage.ts`](https://github.com/openclaw/openclaw/blob/d51917edde3d3949a535131b97dbc6f43c4ea6ef/extensions/openai/usage.ts), inspected through GitHub's contents API, contains:

```ts
if (oauth && isSIWCAuthFlow(oauth.authFlow)) {
  // ChatPass has no supported usage endpoint. Never send its scoped bearer to WHAM.
  return { handled: true };
}
```

Its [regression test](https://github.com/openclaw/openclaw/blob/d51917edde3d3949a535131b97dbc6f43c4ea6ef/extensions/openai/usage.test.ts) is named `does not offer token-sharing credentials to Codex usage or API-key fallback`. It passes `authFlow: "chatgpt-token-sharing"` and asserts `{ handled: true }` without API-key fallback.

The same module supports `/v1/organization/costs` and `/v1/organization/usage/completions` only through a separately supplied admin credential. Those paths are API organization billing/usage, not evidence of subscription percentages accessible to direct OAuth.

### Codewhale is an implementation of the new login, not a quota-reading solution

[Codewhale provider documentation](https://github.com/codewhale-hq/Codewhale/blob/fead51eeea0fb6038ea3e30923751b1a1c765b25/docs/PROVIDERS.md#sign-in-with-chatgpt) describes the official direct flow despite retaining the provider ID `openai-codex`. It uses `/v1/models` and `/v1/responses`, rejects imported legacy Codex tokens for that route, and links users to ChatGPT usage settings. It documents plan-limit errors, not a percentage endpoint. Its provider name must not be mistaken for proof that legacy Codex usage APIs work with the new grant.

A bounded GitHub code search of `earendil-works/pi` for `rate_limits` returned a legacy `openai-codex-stream.test.ts` fixture containing `codex.rate_limits`. That result does not establish any such event for direct OAuth. No direct-flow quota solution was established from Pi in this research.

## Undocumented candidates and what is actually known

The [issue reporter's observations](https://github.com/openai/sign-in-with-chatgpt-devkit/issues/3) name these concrete requests:

| Request | Reported result with the new direct OAuth access token |
| --- | --- |
| `GET https://api.openai.com/v1/models` | HTTP 200 |
| `GET https://chatgpt.com/backend-api/wham/usage` | HTTP 401, `error.code: no_matching_rule` |
| `GET https://chatgpt.com/backend-api/wham/usage/chatpass/apps` | HTTP 401, `error.code: no_matching_rule` |

The reported backend requests used `Authorization: Bearer <direct_access_token>` and `Accept: application/json`, tested both with and without `OAI-App-Brand: chatgpt` and `x-openai-codex-pricing-chooser: 1`. No account ID was guessed from the opaque subject. The report also notes that the legacy Codex backend client uses `GET /wham/usage` without query parameters and an optional `ChatGPT-Account-Id` header.

These are the issue reporter's failed probes, not recommended integration requests. The parent agent later independently reproduced the `/wham/usage` rejection, as recorded below. The collaborator's response supplies the authoritative support status. No primary source located provides additional auth requirements that turn either backend request into a working direct-OAuth quota API. Browser-cookie authorization, if available, would be a separate auth mechanism and would not answer this task.

## Footer decision

The initial recommendation was to replace numeric usage with the official usage-settings link because the new grant cannot report quotas. After reviewing these findings, the user decided on 2026-10-08: **"Use the old way, then."** This supersedes the requested migration to the newer login and the proposed link-only display.

Keep `account/rateLimits/read` through the separate Codex CLI login and preserve the `5h`/`wk` display. Add one refresh-and-retry attempt for an expired Codex token. These values describe the Codex account's plan windows, not Pi-specific app quotas or independently verified usage for Pi's newer login. The user must keep Codex signed into the intended account. If Codex provides no five-hour window, retain `—` rather than inventing a value.

## Live validation

The parent agent independently verified these behaviors on 2026-10-08:

- Pi's `ModelRuntime.getAuth("openai")` resolved the current subscription credential. `GET /v1/models` returned HTTP 200 without quota headers.
- A minimal `POST /v1/responses` using `gpt-6-astra` completed successfully. Its headers contained no usage/quota/limit values, and the stream contained no quota events.
- `GET https://chatgpt.com/backend-api/wham/usage` with that same current credential returned HTTP 401, `rejected_by_access_enforcement`, `no_matching_rule`. This independently reproduces one of the issue reporter's failed probes, not just missing documentation.
- The signed-in ChatGPT usage page displayed weekly plan usage and app-specific windows. Its requests included `/backend-api/wham/usage/chatpass/apps` and used browser-session authorization plus `ChatGPT-Account-Id`. This confirms that numeric data exists for the browser UI, not that the direct OAuth grant can access it. App-specific `windows[].used_percent` is distinct from `allowed_usage_percent`, which is a configured cap.
- The task's browser tab was closed. Temporary probe scripts were deleted. No footer implementation was changed during the investigation; the later refresh-and-retry fix follows the decision above.

Persistent local evidence is under `C:\Users\13982\.pi\agent\logs\openai-footer-validation\`: `openai-probe.txt`, `openai-response-probe.txt`, `new-login-usage-probe.txt`, and `browser-usage-summary.json`. The original legacy-reader error and stack trace are in `repro.txt`; the legacy lookup after explicitly refreshing its separate login is in `after-refresh.txt`. That repair is not a migration to the new login.

## Search bounds and remaining uncertainty

Used Ketch JSON output with bounded GitHub-code searches and official-page extraction, plus read-only GitHub API retrieval. Searches covered the exact direct scope, OpenClaw token-sharing usage handling, Codewhale subscription usage handling, Pi rate-limit references, and quota-related public issues. Search stopped after finding an explicit answer in OpenAI's own repository and corroborating implementation tests. No claims are made about undisclosed partner APIs or future support.
