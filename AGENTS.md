# Valey Shared Context

Valey is a proactive multi-channel agent built for the AI Tinkerers x OpenAI "Agents, Everywhere: Bots, Channels, & More" global hackathon on 12 September 2026 in Hyderabad. It ingests events from the messaging and work channels people already use, judges urgency, chooses the channel that matches that urgency, and asks for explicit approval before acting.

## Architecture

Valey uses a three-layer Sense / Think / Act architecture:

- Sense: inbound adapters publish normalized events.
- Think: core modules redact, classify, decide, and persist runtime memory.
- Act: outbound adapters contact the user or prepare approved actions.

Adapters never import other adapters. Core modules never import adapters directly. The layers communicate through the in-process event bus.

## Event Schema

Every inbound adapter emits exactly this canonical Event shape from `core/events.js`:

```js
{
  id: string,              // "<source>:<sourceMessageId>"
  source: string,          // 'telegram' | 'discord' | 'gmail' | 'calendar'
  sourceMessageId: string,
  threadId: string | null,
  author: { id: string, displayName: string },
  text: string,            // plain text, markup stripped
  receivedAt: string,      // ISO 8601
  meta: object             // source-specific extras, never required by core
}
```

## Decision Schema

`core/decide.js` returns exactly this Decision shape from `core/events.js`:

```js
{
  eventId: string,
  tier: 'critical' | 'high' | 'normal' | 'low',
  reason: string,          // one short human-readable sentence
  channel: 'call' | 'sms' | 'voice' | 'log',
  proposedAction: null | {
    type: 'email_reply' | 'calendar_event' | 'message_reply' | 'alarm',
    summary: string,       // plain-language description shown to the user
    payload: object
  },
  requiresApproval: boolean   // ALWAYS true whenever proposedAction is not null
}
```

## Adapter Contract

Every inbound adapter exports `start()` and `stop()`, and publishes normalized events to the bus.

Every outbound adapter exports one async function returning `{ ok, error? }`.

## Urgency Tiers

- `critical`: maps to `call`
- `high`: maps to `sms`
- `normal`: maps to `voice`
- `low`: maps to `log`

## Security Rules

- Never hardcode a secret.
- All credentials must be read from `process.env` only.
- No secrets, tokens, phone numbers, or email addresses may be committed.
- Use obvious placeholders in examples.
- Sensitive text must pass through `redact(text)` before being sent to a model.
- Financial, payment, transaction, OTP, and security-alert content must not be read aloud or forwarded.
- Valey may draft actions, but must never execute one without explicit user approval.
- No commit message or file may contain AI-tool attribution.

## File Ownership

Developer A owns `adapters/in/gmail.js`, `adapters/in/calendar.js`, `adapters/out/calendar.js`, `adapters/out/call.js`, `adapters/out/sms.js`, `adapters/out/email.js`, and all of `core/`.

Developer B owns `adapters/in/telegram.js`, `adapters/in/discord.js`, and `adapters/out/voice.js`.

Nobody edits a file they do not own.
