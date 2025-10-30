# Alfred Bot Gmail Pub/Sub Handler

This service is a Google Cloud Run function that listens for Gmail push notifications via **Pub/Sub**, fetches recent Gmail message history, and processes updates using the Gmail API.

## Overview

When Gmail sends a push notification to the configured Pub/Sub topic, this Cloud Run function:
1. Decodes the message payload.
2. Fetches the Gmail history since the last recorded `historyId`.
3. Retrieves message metadata (e.g., sender, subject).
4. Stores state in Firestore for tracking sync progress.

## Architecture

```
Gmail → Pub/Sub Topic → Cloud Run (gmail-pubsub-handler) → Firestore
```

- **Pub/Sub Topic:** `projects/project-alfred-bot/topics/gmail`
- **Cloud Run Service:** `gmail-pubsub-handler`
- **Firestore Collection:** `gmail_sync_state`
- **Secret Manager Secret:** `alfred-oauth-credentials`

## Environment Variables

| Variable | Description |
|-----------|--------------|
| `GMAIL_OAUTH_CREDENTIALS` | JSON string containing `client_id`, `client_secret`, and `refresh_token`. |

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

## Deployment

1. Build and deploy with Cloud Run:
   ```bash
   gcloud run deploy gmail-pubsub-handler        --source .        --region us-east1        --trigger-topic gmail        --set-secrets GMAIL_OAUTH_CREDENTIALS=alfred-oauth-credentials:latest
   ```

2. Ensure Pub/Sub and Gmail API are both enabled for your project.

## License

MIT License © 2025 John Ho
