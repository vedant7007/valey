# Valey

Valey is a proactive multi-channel agent built for the AI Tinkerers x OpenAI "Agents, Everywhere: Bots, Channels, & More" global hackathon on 12 September 2026 in Hyderabad.

Most agents wait for a person to open a separate chat window. Valey is designed for the messaging and work channels people already use. It ingests events from those channels, judges urgency, chooses the channel that matches that urgency, and asks for explicit approval before taking any action.

## Problem

Important messages and work events are spread across chat, email, calendar, and team channels. A passive assistant can summarize them only after the user remembers to ask. Valey addresses that gap by initiating contact when something deserves attention, while still keeping the user in control of every action.

## Architecture

Valey follows a Sense / Think / Act architecture:

- Sense: inbound adapters normalize Telegram, Discord, Gmail, and Calendar events.
- Think: core modules redact sensitive data, classify urgency, decide the contact channel, and persist lightweight JSON state.
- Act: outbound adapters place calls, send SMS, produce voice notes, send email, or create calendar updates after approval.

The layers communicate through an in-process event bus. Adapters never import each other, and core modules do not import adapters directly.

## Channel Selection

Valey maps each decision to a channel:

- Critical: phone call
- High: SMS
- Normal: spoken voice note
- Low: log only

The goal is to match interruption level to urgency instead of sending every notification through the same medium.

## Security Model

Credentials are read only from environment variables. Runtime state is written under `state/`, which is ignored by git. Tokens and credential files are also ignored. Sensitive text must be redacted before it is sent to a model. Financial, payment, OTP, and security-alert content is treated as sensitive and is not read aloud or forwarded.

Valey may draft an action, but it never executes one without explicit user approval.

## Setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Fill in the required environment variables.
4. Install dependencies with `npm install`.
5. Run Google authorization when needed with `npm run auth:google`.

## Run

Start the service:

```sh
npm start
```

Run the redaction self-test:

```sh
node core/redact.js
```
