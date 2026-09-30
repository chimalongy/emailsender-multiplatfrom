# Provider connection review

Reviewed 23 September 2026 against official documentation. Plans and account approval are controlled by the provider. The editable app defaults are not a guarantee of quota or approval. The app allows all personas on all connections, provided their domain appears in that connection's verified-domain list.

| Provider | Daily default | 30-day app default | Credentials |
|---|---:|---:|---|
| Brevo | 300 | 9,000 | API key |
| Resend | 100 | 3,000 | API key; optional domain ID and webhook secret |
| Mailgun | 100 | 3,000 | API key + sending domain + US/EU; optional webhook key |
| Elastic Email | 100 | 3,000 | API key with SendHttp |
| GoSend | 100 | 3,000 | Bearer API key |
| Maileroo | No fixed app cap | 3,000 | Domain sending key |
| Sequenzy | No fixed app cap | 2,500 | Bearer API key |
| Mailtrap | 150 | 4,000 | API token |
| NoticeAPI | 100 | 3,000 | Bearer API key |
| Quolle | 100 | 3,000 | Bearer API key (qle_) |

Brevo/Mailgun/GoSend 30-day totals are calculations from daily allowances, not independent monthly entitlements. Maileroo's monthly allowance does not establish 100 guaranteed daily sends. Check account hourly limits. A 31-day month differs from a 30-day planning period. External account usage is not fetched by this project.

## Brevo

In Settings, open Senders/Domains, add your domain and publish its ownership and DKIM values. Authenticate it, create a persona sender if Brevo requests one, then create an API key in SMTP & API. Use the API key, not SMTP credentials. Save the domain and key in Connections. Check setup retrieves verification information; complete missing DNS actions in Brevo.

Sending uses `POST https://api.brevo.com/v3/smtp/email` with `api-key`. The API supports replyTo and headers and returns messageId. Free allowance: 300/day.

Sources: [Domain verification](https://developers.brevo.com/docs/domain-authentication-and-verification), [Sending API](https://developers.brevo.com/docs/send-a-transactional-email), [Free-plan limits](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan).

## Resend

Open Domains → Add domain. Add the shown DKIM and sending return-path records to DNS, then verify. Leave receiving disabled in Resend for the domain handled by Cloudflare. Create a sending API key. Include the domain ID if you want setup checks; domain inspection needs appropriate API permissions.

The adapter calls `POST https://api.resend.com/emails` using Bearer authentication, Reply-To, headers and an idempotency key. Optional signed delivery events use `/api/webhooks/resend`. Free allowance: 100/day and 3,000/month.

Sources: [Domain setup](https://resend.com/docs/dashboard/domains/introduction), [Send API](https://resend.com/docs/api-reference/emails/send-email), [Pricing](https://resend.com/pricing).

## Mailgun

Add a custom domain under Sending → Domains. Select its US/EU region, publish the sending DNS records and verify them. Save that domain, its authorized API key and region. Retain Cloudflare's receiving MX records; do not set Mailgun receiving MX on the same hostname. The sandbox has recipient restrictions and is not your production custom-domain connection.

The adapter uses multipart `POST /v3/{domain}/messages`, HTTP Basic authentication (`api` plus key), and `h:` message headers. Domain checks use the selected region. Optional Mailgun webhook signing uses the account's HTTP webhook signing key. Free allowance: 100/day.

Sources: [Domains](https://documentation.mailgun.com/docs/mailgun/user-manual/domains/domains), [Messages](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages), [Free plan](https://help.mailgun.com/hc/en-us/articles/203068914-What-does-the-Free-plan-offer).

## Elastic Email

Open Settings → Domains, add your domain and authenticate it using the displayed DNS records. Create an API key with SendHttp permission, save it here, and confirm the account is enabled for external recipients before using it.

Sending uses `POST https://api.elasticemail.com/v4/emails/transactional`, the X-ElasticEmail-ApiKey header, and Content/Recipients objects. ReplyTo and Headers are supported. Pricing advertises 100/day and up to 3,000/month. The new-account help page contains conflicting language about recipient restrictions, so account approval must be checked rather than assuming universal external access.

Sources: [API reference](https://elasticemail.com/developers/api-documentation/rest-api), [Pricing](https://elasticemail.com/email-api-pricing), [New accounts](https://help.elasticemail.com/en/articles/2446055-what-are-sending-limits-for-new-accounts).

## GoSend

Select GoSend-managed AWS SES delivery under Domains. Add the domain and its shown DKIM/SPF/MAIL FROM/DMARC records, wait for verification, and create a Bearer API key. Bring-your-own SMTP/Resend sender accounts use those upstream accounts and should not be counted as an independent free delivery allowance.

Sending uses `POST https://www.gosend.dev/api/v1/emails`. The documented API accepts from, to, subject and HTML; it does not document custom Reply-To or threading headers. Accordingly this adapter omits unsupported fields. Persona addresses on a GoSend-managed verified domain are supported; replies may need manual association. GoSend advertises 100 free daily messages, subject to account access.

Sources: [Docs](https://www.gosend.dev/docs), [Plan advertisement](https://www.gosend.dev/).

## Maileroo

Add your domain in Domains and publish the provided authentication records. Once verified, create a key in that domain's Sending Keys. Paste the sending key into the app. Account-management tokens are separate from sending keys.

Sending uses `POST https://smtp.maileroo.com/api/v2/emails`, Bearer authentication, address/display_name objects, reply_to and custom headers. A reference ID links the provider record. The free plan lists 3,000 outbound messages/month and two custom domains, with account-specific hourly limits. There is no fixed daily allowance asserted by this app.

Sources: [Sending](https://maileroo.com/docs/api-reference/emails/send-email), [Authentication](https://maileroo.com/docs/api-reference/emails/introduction), [Free plan](https://maileroo.com/help/what-are-differences-between-free-paid-plans).

## Sequenzy

Add and authenticate the sending domain in the dashboard, then create an API key with transactional sending access. Disable reply tracking so Sequenzy does not replace the app's unique Reply-To with its own tracking address.

Sending uses `POST https://api.sequenzy.com/api/v1/transactional/send` with Bearer authentication, from, to, subject, body and replyTo. The documented request schema does not include custom threading headers, so the app does not invent them. Cloudflare can match the unique reply address, but recipient-client threading is not guaranteed. Free allowance: 2,500/month; no daily cap asserted here.

Sources: [Transactional API](https://docs.sequenzy.com/api-reference/transactional/send), [Pricing](https://www.sequenzy.com/pricing).
 
## Mailtrap

Open Sending Domains → Add Domain. Publish the displayed DNS records (SPF, DKIM, DMARC) in your DNS provider and verify them. Under API Tokens or Sending Domains, copy your Sending API Token. Paste the token here.

Sending uses `POST https://send.api.mailtrap.io/api/send` with Bearer authentication, from object, to array, subject, text, html, reply_to object, headers, and category. The adapter supports Check Setup using `GET https://mailtrap.io/api/domains` to inspect verification and compliance status. Free allowance: 150/day and 4,000/month.

Sources: [Sending API](https://docs.mailtrap.io/docs/sending-api-reference), [Domains API](https://docs.mailtrap.io/api/domains), [Pricing](https://mailtrap.io/pricing/).

## NoticeAPI

Add your sending domain in the NoticeAPI dashboard under Domains. Publish the displayed DNS records (Ownership, SPF, DKIM) in your DNS provider and verify them. Add a payment card to activate production sending ($0/month free tier). Copy your API key (starting with `ntc_`) and paste it here.

Sending uses `POST https://www.noticeapi.com/api/v1/email/send` with Bearer authentication, `from` string, `to` string, `subject`, `text`, `html`, `reply_to`, custom `headers`, and an `Idempotency-Key` header. The adapter supports Check Setup using `GET https://www.noticeapi.com/api/v1/domains` to inspect verification status when authorized. Free allowance: 100/day and 3,000/month.

Sources: [Docs](https://www.noticeapi.com/docs), [Pricing](https://www.noticeapi.com/pricing).

## Quolle

Open Domains in your Quolle dashboard and add your sending domain. Add the displayed DNS records (SPF, DKIM, DMARC) to your DNS provider and verify. Under API Keys, generate a key (starts with `qle_`). Paste the key here.

Sending uses `POST https://api.quolle.com/v1/emails/send` with Bearer authentication, `from`, `to`, `subject`, `text`, `html`, `replyTo`, and an `Idempotency-Key` header. The adapter supports Check Setup using `GET https://api.quolle.com/v1/domains` to inspect domain verification status. Free Starter allowance: 100/day and 3,000/month.

Sources: [Docs](https://quolle.com/docs), [Pricing](https://quolle.com/pricing).
