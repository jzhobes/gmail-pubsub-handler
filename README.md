# Alfred Bot Gmail Pub/Sub Handler

This project deploys a Google Cloud Run service that reacts to Gmail push notifications delivered by **Pub/Sub**, loads recent Gmail message history, and orchestrates follow-up actions in Google Calendar and Google Drive.

## Overview

When Gmail sends a push notification to the configured Pub/Sub topic, this Cloud Run function:

1. Decodes the message payload.
2. Fetches the Gmail history since the last recorded `historyId`.
3. Retrieves message metadata (e.g., sender, subject) for new messages.
4. Stores state in Firestore to track the most recent Gmail history ID.
5. Routes messages to specialized handlers:
   - **Calendar**: Tidies up reminders for common bill-payment emails.
   - **Drive**: Downloads and archives PDF bills (e.g., National Grid).

## Data Flow

```
Gmail → Pub/Sub Topic → Cloud Run → Google Calendar
                            ↓      ↘
                        Firestore   Google Drive
                            ↓
                    National Grid Website
```

## Runtime Environment Variables

| Variable                    | Required | Description                                                                                                                          |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GMAIL_OAUTH_CREDENTIALS`   | ✅       | JSON string containing `client_id`, `client_secret`, and `refresh_token` used for Gmail/Calendar/Drive access.                       |
| `FIRESTORE_COLLECTION`      | ✅       | Name of the Firestore collection used to persist the latest Gmail history IDs per mailbox.                                           |
| `CALENDAR_NAME`             | ✅       | Google Calendar display name that will be queried and updated by the payment handlers.                                               |
| `NATIONAL_GRID_CREDENTIALS` | ❌       | (Optional) JSON string containing `signInName`, `password`, `accountNumber`, and `subscriptionKey` for National Grid account access. |

## OAuth Setup

Generate OAuth credentials using `refreshToken.js`:

1. Create Google OAuth client credentials in Google Cloud Console
2. Update `refreshToken.js` with your `client_id` and `client_secret`
3. Run `node refreshToken.js` and follow the authorization flow
4. Store the resulting JSON in Secret Manager

## Supported Payment Handlers

The system automatically processes these payment confirmation emails:

| Provider                    | Email Pattern                                       | Action                                                               |
| --------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| **National Grid**           | `nationalgridus.com` + "bill is ready"              | Download PDF bill & upload to Drive                                  |
| **Sunrun**                  | Subject "sunrun bill" + Sender/Body "sunrun"        | Extract PDF attachment & upload to Drive                             |
| **American Express**        | `americanexpress.com` + "received your payment"     | Delete "Pay Amex" reminders                                          |
| **Chase Credit Card**       | `chase.com` + "credit card payment is scheduled"    | Delete "Pay Chase" reminders                                         |
| **Chase Mortgage**          | `chase.com` + "you scheduled your mortgage payment" | Delete "Pay mortgage" reminders                                      |
| **Comcast/Xfinity**         | `chase.com` + "transaction with comcast / xfinity"  | Delete "Comcast / Xfinity Withdrawal" reminders                      |
| **Eversource**              | `chase.com` + "transaction with spi\*eversource"    | Update "Pay Gas Bill" with amount                                    |
| **Capital One Withdrawals** | `capitalone.com` + "withdrawal notice"              | Delete various bill reminders (AT&T, Lowes, Eastern Savings, Sunrun) |

Processed emails are automatically marked as read.

## Deployment

### Required OAuth Scopes

- `https://www.googleapis.com/auth/gmail.readonly` - Read Gmail messages and history
- `https://www.googleapis.com/auth/gmail.modify` - Mark messages as read
- `https://www.googleapis.com/auth/calendar` - Read/modify calendar events
- `https://www.googleapis.com/auth/drive.file` - Upload bills to Google Drive

### Service Account Permissions

| Service Account                                                   | Role                                   |
| ----------------------------------------------------------------- | -------------------------------------- |
| `default compute service account`                                 | Editor, Secret Manager Secret Accessor |
| `service-<project>@serverless-robot-prod.iam.gserviceaccount.com` | Secret Manager Secret Accessor         |
| `gmail-api-push@system.gserviceaccount.com`                       | Pub/Sub Publisher                      |

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

### ❌ `Request had insufficient authentication scopes`

Occurs when OAuth credentials lack required scopes. Regenerate refresh token with all required scopes using `refreshToken.js`.

## Local Development

- Install dependencies: `npm install`
- Lint sources: `npm run lint`
- Run the local Functions Framework: `npm start`
- Run the Gmail/Calendar smoke test helper: `npm test` (or `node index.test.js 15` to raise the fetch limit)

The test harness expects the same environment variables/secret JSON that production uses.

## Testing

### Unit Tests

Run the standard unit test suite (mocks external services):

```bash
npm test
```

### Integration Tests

To run integration tests that interact with real Gmail, Drive, and National Grid APIs:

1. Ensure your `.env` file has valid credentials.
2. Remove `.skip` from the integration tests in `index.test.js`.
3. Run the tests:

```bash
npm test -- --testNamePattern="INTEGRATION"
```

**Note:** Integration tests require real emails in your inbox to function (e.g., a real National Grid or Sunrun bill email).

## License

MIT License © 2025 John Ho
