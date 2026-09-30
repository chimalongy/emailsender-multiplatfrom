export const providers = {
  brevo: {
    name: "Brevo",
    daily: 300,
    monthly: 9000,
    providerMonthly: null,
    fields: ["apiKey"],
    url: "https://developers.brevo.com/docs/domain-authentication-and-verification",
    steps:
      "Open Settings → Senders, Domains & Dedicated IPs → Domains. Add your domain, copy the ownership and DKIM records into DNS, then authenticate. Add each persona as a sender if requested. Create an API key under SMTP & API (not an SMTP key).",
    note: "300/day; the 9,000 figure is a 30-day planning cap.",
  },
  resend: {
    name: "Resend",
    daily: 100,
    monthly: 3000,
    providerMonthly: 3000,
    fields: ["apiKey", "domainId", "webhookSecret"],
    url: "https://resend.com/docs/dashboard/domains/introduction",
    steps:
      "Open Domains → Add domain. Copy the displayed DKIM and sending return-path records; click Verify DNS Records. Leave receiving disabled in Resend because Cloudflare handles incoming email. Create an API key and copy the domain ID for status checks.",
    note: "100/day and 3,000/month. Domain ID enables the DNS check. Webhook secret is optional.",
  },
  mailgun: {
    name: "Mailgun",
    daily: 100,
    monthly: 3000,
    providerMonthly: null,
    fields: ["apiKey", "sendingDomain", "webhookSecret"],
    url: "https://documentation.mailgun.com/docs/mailgun/user-manual/domains/domains",
    steps:
      "Open Sending → Domains → Add domain. Choose US or EU, publish the displayed SPF/DKIM records, and verify. Copy the sending domain and API key. Use your own verified domain, not the restricted sandbox. Keep receiving MX at Cloudflare; do not enable Mailgun receiving on that hostname.",
    note: "100/day. Select the region used when registering your sending domain.",
  },
  elastic: {
    name: "Elastic Email",
    daily: 100,
    monthly: 3000,
    providerMonthly: 3000,
    fields: ["apiKey"],
    url: "https://elasticemail.com/developers/api-documentation/rest-api",
    steps:
      "Open Settings → Domains and add your domain. Publish the supplied SPF/DKIM records and verify. Create an API key with SendHttp permission. Confirm the account is approved for external recipients before enabling it.",
    note: "100/day advertised; new-account documentation contains conflicting recipient-restriction language. Confirm your account access.",
  },
  gosend: {
    name: "GoSend",
    daily: 100,
    monthly: 3000,
    providerMonthly: null,
    fields: ["apiKey"],
    url: "https://www.gosend.dev/docs",
    steps:
      "Use Domains for GoSend-managed AWS SES delivery. Add your domain and publish its DKIM, SPF, MAIL FROM and DMARC records. Create an API key. Do not use a bring-your-own Resend/SMTP sender to count an additional independent allowance.",
    note: "100/day advertised. Custom Reply-To and threading headers are not documented; replies may need manual linking.",
  },
  maileroo: {
    name: "Maileroo",
    daily: null,
    monthly: 3000,
    providerMonthly: 3000,
    fields: ["apiKey"],
    url: "https://maileroo.com/docs/api-reference/emails/send-email",
    steps:
      "Open Domains → Add domain. Publish the DNS records displayed for your domain and verify them. Open the domain’s Sending Keys and create a sending key. Use that key here, rather than an account-management token.",
    note: "3,000/month; no fixed daily allowance. Account-specific hourly limits still apply.",
  },
  sequenzy: {
    name: "Sequenzy",
    daily: null,
    monthly: 2500,
    providerMonthly: 2500,
    fields: ["apiKey"],
    url: "https://docs.sequenzy.com/api-reference/transactional/send",
    steps:
      "Add a sending domain in the Sequenzy dashboard and complete its DNS verification. Create an API key with transactional sending access. Disable reply tracking in Sequenzy so your Reply-To address continues to point to Cloudflare.",
    note: "2,500/month. Supports Reply-To, but custom threading headers are not documented.",
  },
  mailtrap: {
    name: "Mailtrap",
    daily: 150,
    monthly: 4000,
    providerMonthly: 4000,
    fields: ["apiKey"],
    url: "https://docs.mailtrap.io/docs/sending-api-reference",
    steps:
      "Open Sending Domains → Add Domain. Publish the displayed DNS records (SPF, DKIM, DMARC) in your DNS provider and verify them. Under API Tokens or Sending Domains, copy your Sending API Token. Paste the API token here.",
    note: "150/day and 4,000/month on the free tier. Requires domain verification in Mailtrap Sending.",
  },
  noticeapi: {
    name: "NoticeAPI",
    daily: 100,
    monthly: 3000,
    providerMonthly: 3000,
    fields: ["apiKey"],
    url: "https://www.noticeapi.com/docs",
    steps:
      "Add your sending domain in the NoticeAPI dashboard under Domains. Publish the displayed DNS records (Ownership, SPF, DKIM) in your DNS provider and verify them. Add a payment card to activate production sending ($0/month free tier). Copy your API key (starting with ntc_) and paste it here.",
    note: "100/day and 3,000/month on the Free plan. Requires card on file to activate production sending ($0 fee).",
  },
  quolle: {
    name: "Quolle",
    daily: 100,
    monthly: 3000,
    providerMonthly: 3000,
    fields: ["apiKey"],
    url: "https://quolle.com/docs",
    steps:
      "Open Domains in your Quolle dashboard and add your sending domain. Add the displayed DNS records (SPF, DKIM, DMARC) to your DNS provider and verify. Under API Keys, generate a key (starts with qle_). Paste the key here.",
    note: "100/day and 3,000/month on the free Starter plan. API keys start with qle_.",
  },
  senddev: {
    name: "Send.dev",
    daily: 100,
    monthly: 3000,
    providerMonthly: 3000,
    fields: ["apiKey"],
    url: "https://docs.do.dev/send",
    steps:
      "Open Domains in your do.dev / send.dev dashboard, add your domain, and publish the displayed DNS records (DKIM, SPF, ownership TXT). Once verified, create an API key under API Keys with send:write permission. Paste the API key here.",
    note: "3,000/month on the free Hobby plan. Rate limit: 10 requests/min. Note: custom threading headers are intentionally not supported by send.dev API.",
  },
  epostix: {
    name: "Epostix",
    daily: 100,
    monthly: 3000,
    providerMonthly: 3000,
    fields: ["apiKey"],
    url: "https://docs.epostix.com",
    steps:
      "Add a sending domain in your Epostix dashboard under Domains. Publish the displayed DNS records (SPF, DKIM, reverse DNS) in your DNS provider and verify. Under API Keys, generate a key (starts with tix_live_). Paste the key here.",
    note: "3,000 emails/month on the Free plan (€0/mo). EU-hosted with GDPR compliance. API keys start with tix_live_.",
  },
  cloudflare: {
    name: "Cloudflare receiving",
    fields: ["accountId", "zoneId", "apiKey"],
    url: "https://developers.cloudflare.com/email-service/api/route-emails/email-handler/",
    steps:
      "Enable Email Routing for your domain. Deploy the included worker, configure its secrets and allowed domains, then route your persona addresses and reply+ catch-all addresses to that Worker.",
    note: "Account/zone IDs identify your deployment. A read-only API token is optional for zone checks; Worker deployment uses Wrangler authentication.",
  },
};
