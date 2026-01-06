import 'dotenv/config';
import { google } from 'googleapis';

const { GMAIL_OAUTH_CREDENTIALS, CALENDAR_NAME } = process.env;
if (!GMAIL_OAUTH_CREDENTIALS || !CALENDAR_NAME) {
  throw new Error(
    'GMAIL_OAUTH_CREDENTIALS and CALENDAR_NAME env vars are required for the debug test'
  );
}

const { client_id, client_secret, refresh_token } = JSON.parse(
  GMAIL_OAUTH_CREDENTIALS
);
const auth = new google.auth.OAuth2(client_id, client_secret);
auth.setCredentials({ refresh_token });
const gmail = google.gmail({ version: 'v1', auth });
const calendar = google.calendar({ version: 'v3', auth });

export async function testGmailConnectivity(limit = 10) {
  console.log(`🔬 Listing up to ${limit} recent Gmail messages`);
  try {
    const messagesRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: limit,
    });
    const messages = messagesRes.data.messages || [];

    if (!messages.length) {
      console.log('No Gmail messages returned.');
      return;
    }

    for (const { id } of messages) {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From'],
      });
      const headers = detail.data.payload?.headers || [];
      const from = headers.find((h) => h.name === 'From')?.value || '<no from>';
      const subject =
        headers.find((h) => h.name === 'Subject')?.value || '<no subject>';
      console.log(`• ${from} — ${subject}`);
    }
  } catch (e) {
    console.error(`❌ Failed to list Gmail messages: ${e.message}`);
  }
}

export async function testCalendarConnectivity(limit = 10) {
  console.log(
    `🔬 Listing up to ${limit} events from calendar "${CALENDAR_NAME}"`
  );
  try {
    const calendarList = await calendar.calendarList.list();
    const targetCal = calendarList.data.items?.find(
      (c) => c.summary === CALENDAR_NAME
    );
    if (!targetCal) {
      console.log(`No calendar named "${CALENDAR_NAME}" found.`);
      return;
    }

    const eventsRes = await calendar.events.list({
      calendarId: targetCal.id,
      maxResults: limit,
      singleEvents: true,
      orderBy: 'startTime',
      timeMin: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const events = eventsRes.data.items || [];

    if (!events.length) {
      console.log('No calendar events returned.');
      return;
    }

    for (const event of events) {
      const start =
        event.start?.dateTime || event.start?.date || 'unknown start';
      console.log(`• ${start} → ${event.summary || '<no summary>'}`);
    }
  } catch (e) {
    console.error(`❌ Failed to list calendar events: ${e.message}`);
  }
}

export async function runConnectivitySmokeTest(limit = 10) {
  await testGmailConnectivity(limit);
  await testCalendarConnectivity(limit);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const limitArg = Number(process.argv[2]);
  runConnectivitySmokeTest(
    Number.isFinite(limitArg) ? limitArg : undefined
  ).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
