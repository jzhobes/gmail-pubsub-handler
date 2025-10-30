# Alfred Bot Gmail Pub/Sub Handler

This project deploys a Google Cloud Run service that reacts to Gmail push notifications delivered by **Pub/Sub**, loads recent Gmail message history, and orchestrates follow-up actions in Google Calendar.

## Overview

When Gmail sends a push notification to the configured Pub/Sub topic, this Cloud Run function:
1. Decodes the message payload.
2. Fetches the Gmail history since the last recorded `historyId`.
3. Retrieves message metadata (e.g., sender, subject) for new messages.
4. Stores state in Firestore to track the most recent Gmail history ID.
5. Routes messages to specialized handlers that tidy up Google Calendar reminders for common bill-payment emails (Chase credit card & mortgage, Comcast/Xfinity, Eversource/Speedpay).

## Architecture

```
Gmail → Pub/Sub Topic → Cloud Run (gmail-pubsub-handler) → Firestore
```

- **Pub/Sub Topic:** `projects/project-alfred-bot/topics/gmail`
- **Cloud Run Service:** `gmail-pubsub-handler`
- **Firestore Collection:** `gmail_sync_state`
- **Secret Manager Secret:** `alfred-oauth-credentials`

## Runtime Environment Variables

| Variable | Required | Description |
|-----------|----------|--------------|
| `GMAIL_OAUTH_CREDENTIALS` | ✅ | JSON string containing `client_id`, `client_secret`, and `refresh_token` used for Gmail/Calendar access. |
| `FIRESTORE_COLLECTION` | ✅ | Name of the Firestore collection used to persist the latest Gmail history IDs per mailbox. |
| `CALENDAR_NAME` | ✅ | Google Calendar display name that will be queried and updated by the payment handlers. |

## Permissions Required

| Service Account | Role |
|------------------|------|
| `default compute service account` | Editor, Secret Manager Secret Accessor |
| `service-<project>@serverless-robot-prod.iam.gserviceaccount.com` | Secret Manager Secret Accessor |
| `gmail-api-push@system.gserviceaccount.com` | Pub/Sub Publisher |

## Example Log Output

```
📩 Gmail Push payload: {"emailAddress":"example@gmail.com","historyId":"123456"}
🔍 Fetching Gmail history since 123456
📬 Gmail History fetched: 44 items
❌ Gmail API error: Requested entity was not found.
```

## Common Errors

### ❌ `Requested entity was not found`
Occurs when Gmail’s history ID has expired or been invalidated. You must reset the stored `historyId` in Firestore by deleting the document for that email address.

### ⚠️ `No message data found.`
Indicates the Pub/Sub message payload was empty or malformed.

## Local Development

- Install dependencies: `npm install`
- Lint sources: `npm run lint`
- Run the local Functions Framework: `npm start`
- Run the Gmail/Calendar smoke test helper: `npm test` (or `node index.test.js 15` to raise the fetch limit)

The test harness expects the same environment variables/secret JSON that production uses.

## License

MIT License © 2025 John Ho
