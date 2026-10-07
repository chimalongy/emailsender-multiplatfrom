# Provider connection review

Reviewed 23 September 2026 against official documentation. Plans and account approval are controlled by the provider. The editable app defaults are not a guarantee of quota or approval. The app allows all personas on all connections, provided their domain appears in that connection's verified-domain list.

| Provider | Daily default | 30-day app default | Credentials |
|---|---:|---:|---|
| Brevo | 300 | 9,000 | API key |
| Resend | 100 | 3,000 | API key; optional domain ID and webhook secret |
| Elastic Email | 100 | 3,000 | API key with SendHttp |
| Sequenzy | No fixed app cap | 2,500 | Bearer API key |
| Mailtrap | 150 | 4,000 | API token |
| Quolle | 100 | 3,000 | Bearer API key (qle_) |
| Send.dev | 100 | 3,000 | Bearer API key |
| Epostix | 100 | 3,000 | Bearer API key (tix_live_) |
| Anypost | 100 | 3,000 | Bearer API key (ap_) |

Brevo 30-day totals are calculations from daily allowances, not independent monthly entitlements. A 31-day month differs from a 30-day planning period. External account usage is not fetched by this project.

## Brevo

In Settings, open Senders/Domains, add your domain and publish its ownership and DKIM values. Authenticate it, create a persona sender if Brevo requests one, then create an API key in SMTP & API. Use the API key, not SMTP credentials. Save the domain and key in Connections. Check setup retrieves verification information; complete missing DNS actions in Brevo.

Sending uses `POST https://api.brevo.com/v3/smtp/email` with `api-key`. The API supports replyTo and headers and returns messageId. Free allowance: 300/day.

Sources: [Domain verification](https://developers.brevo.com/docs/domain-authentication-and-verification), [Sending API](https://developers.brevo.com/docs/send-a-transactional-email), [Free-plan limits](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan).

## Resend

Open Domains → Add domain. Add the shown DKIM and sending return-path records to DNS, then verify. Leave receiving disabled in Resend for the domain handled by Cloudflare. Create a sending API key. Include the domain ID if you want setup checks; domain inspection needs appropriate API permissions.

The adapter calls `POST https://api.resend.com/emails` using Bearer authentication, Reply-To, headers and an idempotency key. Optional signed delivery events use `/api/webhooks/resend`. Free allowance: 100/day and 3,000/month.

Sources: [Domain setup](https://resend.com/docs/dashboard/domains/introduction), [Send API](https://resend.com/docs/api-reference/emails/send-email), [Pricing](https://resend.com/pricing).

## Elastic Email

Open Settings → Domains, add your domain and authenticate it using the displayed DNS records. Create an API key with SendHttp permission, save it here, and confirm the account is enabled for external recipients before using it.

Sending uses `POST https://api.elasticemail.com/v4/emails/transactional`, the X-ElasticEmail-ApiKey header, and Content/Recipients objects. ReplyTo and Headers are supported. Pricing advertises 100/day and up to 3,000/month. The new-account help page contains conflicting language about recipient restrictions, so account approval must be checked rather than assuming universal external access.

Sources: [API reference](https://elasticemail.com/developers/api-documentation/rest-api), [Pricing](https://elasticemail.com/email-api-pricing), [New accounts](https://help.elasticemail.com/en/articles/2446055-what-are-sending-limits-for-new-accounts).

## Sequenzy

Add and authenticate the sending domain in the dashboard, then create an API key with transactional sending access. Disable reply tracking so Sequenzy does not replace the app's unique Reply-To with its own tracking address.

Sending uses `POST https://api.sequenzy.com/api/v1/transactional/send` with Bearer authentication, from, to, subject, body and replyTo. The documented request schema does not include custom threading headers, so the app does not invent them. Cloudflare can match the unique reply address, but recipient-client threading is not guaranteed. Free allowance: 2,500/month; no daily cap asserted here.

Sources: [Transactional API](https://docs.sequenzy.com/api-reference/transactional/send), [Pricing](https://www.sequenzy.com/pricing).
 
## Mailtrap

Open Sending Domains → Add Domain. Publish the displayed DNS records (SPF, DKIM, DMARC) in your DNS provider and verify them. Under API Tokens or Sending Domains, copy your Sending API Token. Paste the token here.

Sending uses `POST https://send.api.mailtrap.io/api/send` with Bearer authentication, from object, to array, subject, text, html, reply_to object, headers, and category. The adapter supports Check Setup using `GET https://mailtrap.io/api/domains` to inspect verification and compliance status. Free allowance: 150/day and 4,000/month.

Sources: [Sending API](https://docs.mailtrap.io/docs/sending-api-reference), [Domains API](https://docs.mailtrap.io/api/domains), [Pricing](https://mailtrap.io/pricing/).


## Quolle

Open Domains in your Quolle dashboard and add your sending domain. Add the displayed DNS records (SPF, DKIM, DMARC) to your DNS provider and verify. Under API Keys, generate a key (starts with `qle_`). Paste the key here.

Sending uses `POST https://api.quolle.com/v1/emails/send` with Bearer authentication, `from`, `to`, `subject`, `text`, `html`, `replyTo`, and an `Idempotency-Key` header. The adapter supports Check Setup using `GET https://api.quolle.com/v1/domains` to inspect domain verification status. Free Starter allowance: 100/day and 3,000/month.

Sources: [Docs](https://quolle.com/docs), [Pricing](https://quolle.com/pricing).

## Send.dev

Open Domains in your do.dev / send.dev dashboard, add your domain, and publish the displayed DNS records (DKIM, SPF, ownership TXT). Once verified, create an API key under API Keys with send:write permission. Paste the API key here.

Sending uses `POST https://api.do.dev/v1/send/emails/send` with Bearer authentication, `from` object (`email`, `name`), `to` array, `subject`, `text`, `html`, and `replyTo`. Note that custom threading headers are explicitly rejected by send.dev with a 400 validation error, so the adapter omits them while preserving the unique `replyTo` address. The adapter supports Check Setup using `GET https://api.do.dev/v1/send/domains`. Free Hobby allowance: 3,000/month (100/day soft planning cap, 10 requests/minute rate limit).

Sources: [Docs](https://docs.do.dev/send), [Pricing & Limits](https://docs.do.dev/send).

## Epostix

Add a sending domain in your Epostix dashboard under Domains. Publish the displayed DNS records (SPF, DKIM, reverse DNS) in your DNS provider and verify them. Under API Keys, generate a key with transactional sending scope (starts with `tix_live_`). Paste the key here.

Sending uses `POST https://api.epostix.com/v1/emails` with Bearer authentication, `from`, `to` array, `subject`, `text`, `html`, `reply_to`, custom `headers`, and an `Idempotency-Key` header. The adapter supports Check Setup using `GET https://api.epostix.com/v1/domains` to inspect verification status. Free allowance: 3,000/month (€0/mo, 100/day soft planning cap). EU-hosted with native GDPR compliance.

Sources: [Docs](https://docs.epostix.com/), [API Reference](https://docs.epostix.com/api/reference/send-email).

## Anypost

Add a sending domain in your Anypost dashboard under Domains. Publish the displayed CNAME DNS records in your DNS provider and verify them. Under API Keys, generate a key with Full or Send-only access (starts with `ap_`). Paste the key here.

Sending uses `POST https://api.anypost.com/v1/email` with Bearer authentication, `from`, `to` array, `subject`, `text`, `html`, `reply_to`, custom `headers`, and an `Idempotency-Key` header. The adapter supports Check Setup using `GET https://api.anypost.com/v1/domains` to inspect domain verification status. Free allowance: 100/day and 3,000/month (hard cap, $0 forever). Rate limit: 60 sends/min.

Sources: [Docs](https://anypost.com/docs), [API Reference](https://anypost.com/docs/send-email).
