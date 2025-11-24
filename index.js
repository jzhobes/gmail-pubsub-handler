import 'dotenv/config';
import { cloudEvent } from '@google-cloud/functions-framework';
import { Firestore } from '@google-cloud/firestore';
import { google } from 'googleapis';
import { checkAndMarkMessageProcessed } from './deduplication.js';

const { GMAIL_OAUTH_CREDENTIALS, FIRESTORE_COLLECTION, CALENDAR_NAME } = process.env;
if (!GMAIL_OAUTH_CREDENTIALS || !FIRESTORE_COLLECTION || !CALENDAR_NAME) {
    throw new Error('GMAIL_OAUTH_CREDENTIALS, FIRESTORE_COLLECTION, and CALENDAR_NAME env vars are required');
}

// Initialize Firestore
const firestore = new Firestore();

// Initialize Gmail API client and authenticate
const { client_id, client_secret, refresh_token } = JSON.parse(process.env.GMAIL_OAUTH_CREDENTIALS);
const auth = new google.auth.OAuth2(client_id, client_secret);
auth.setCredentials({ refresh_token });
const gmail = google.gmail({ version: 'v1', auth });
const calendar = google.calendar({ version: 'v3', auth });

// Handle Pub/Sub Gmail push notifications
cloudEvent('gmailPubSubHandler', async cloudEvent => {
    try {
        const message = cloudEvent.data?.message;
        if (!message?.data) {
            console.warn('⚠️ No message data found.');
            return;
        }

        // Decode Base64 → JSON
        const dataStr = Buffer.from(message.data, 'base64').toString('utf8');
        const payload = JSON.parse(dataStr);
        console.log(`📩 Gmail Push payload: ${JSON.stringify(payload)}`);
        // e.g. { emailAddress: 'you@gmail.com', historyId: '21981268' }

        const email = payload.emailAddress || 'me';
        const newHistoryId = payload.historyId;

        // Load last known historyId from Firestore
        const docRef = firestore.collection(FIRESTORE_COLLECTION).doc(email);
        const docSnap = await docRef.get();
        const lastHistoryId = docSnap.exists ? docSnap.data().lastHistoryId : null;

        // Skip if this historyId is not newer than what we've already processed
        if (lastHistoryId && newHistoryId <= lastHistoryId) {
            console.log(`⏭️ Skipping ${newHistoryId < lastHistoryId ? 'old' : 'duplicate'} historyId: ${newHistoryId} (last: ${lastHistoryId})`);
            return;
        }

        // Decide which historyId to start from
        const startId = lastHistoryId || newHistoryId;

        console.log(`🔍 Fetching Gmail history since ${startId}`);

        try {
            const success = await processGmailHistory(startId);
            if (!success) {
                console.log('📬 Gmail History: No changes since last check');
                return;
            }

            // Persist the latest historyId
            await docRef.set({ lastHistoryId: newHistoryId }, { merge: true });
            console.log(`✅ Updated Firestore lastHistoryId → ${newHistoryId}`);
        } catch (apiErr) {
            if (apiErr?.response?.status === 400) {
                console.warn(`'⚠️ Invalid historyId detected. Resetting baseline. Error: ${apiErr.message}'`);
                try {
                    const profile = await gmail.users.getProfile({ userId: 'me' });
                    const resetHistoryId = profile.data.historyId;
                    await docRef.set({ lastHistoryId: resetHistoryId }, { merge: true });
                    console.log(`✅ Baseline reset → ${resetHistoryId}`);
                } catch (resetErr) {
                    console.error(`'❌ Failed to reset baseline: ${resetErr.message}'`);
                }
            } else {
                console.error(`❌ Gmail API error: ${apiErr.message}`);
            }
        }
    } catch (err) {
        console.error(`❌ Error processing Gmail Pub/Sub message: ${err.message}`);
    }
});

/**
 * Fetches and processes Gmail history starting from a specific history ID.
 * Iterates through added messages, deduplicates them, and handles transactions.
 *
 * @param {string} startHistoryId - The history ID to start fetching changes from.
 * @returns {Promise<boolean>} - Returns `true` if history was successfully processed, `false` if no history was found.
 */
export async function processGmailHistory(startHistoryId) {
    // Fetch recent Gmail changes
    const res = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
    });

    if (!res.data.history) {
        return false;
    }

    console.log(`📬 Gmail History fetched: ${res.data.history.length} items`);

    for (const { messagesAdded = [] } of res.data.history) {
        for (const { message } of messagesAdded) {
            try {
                // Deduplicate based on message ID
                const isNew = await checkAndMarkMessageProcessed(firestore, message.id);
                if (!isNew) {
                    console.log(`⏭️ Skipping duplicate message: ${message.id}`);
                    continue;
                }

                const msg = await gmail.users.messages.get({ userId: 'me', id: message.id });
                const subject = msg.data.payload.headers.find(h => h.name === 'Subject')?.value || '';
                const from = msg.data.payload.headers.find(h => h.name === 'From')?.value || '';

                // Debug purposes.
                // const timestamp = msg.data.payload.headers.find(h => h.name === 'Date')?.value || '';
                // const estTime = timestamp ? new Date(timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '';
                // console.log(`📧 Date="${estTime}" Message: From="${from}" Subject="${subject}"`);

                const wasProcessed = await handleTransaction({ from, subject, message: msg });
                if (wasProcessed) {
                    await markMessageAsRead({ from, subject, messageId: message.id });
                }
            } catch (err) {
                if (err.code === 404) {
                    console.warn(`👻 Skipping missing message: ${message.id}`);
                    continue;
                }
                // Log error but continue processing other messages (Poison Pill protection)
                console.error(`❌ Error processing message ${message.id}: ${err.message}`);
                continue;
            }
        }
    }

    return true;
}

/**
 * Analyzes an email to detect and handle specific financial transactions.
 * If a match is found, it triggers calendar event updates.
 *
 * @param {Object} params - The parameters.
 * @param {string} params.from - The sender's email address.
 * @param {string} params.subject - The email subject.
 * @param {Object} params.message - The full Gmail message object.
 * @returns {Promise<boolean>} - Returns `true` if a transaction was matched and processed, `false` otherwise.
 */
async function handleTransaction({ from, subject, message }) {
    const sender = from.toLowerCase();
    const subj = subject.toLowerCase();

    // ✅ Capital One withdrawal notice
    if (sender.includes('capitalone.com') && subj.includes('withdrawal notice')) {
        console.log(`🏦 Checking Capital One withdrawal notice for "${subject}"`);
        const body = extractEmailBody(message).toLowerCase();

        if (body.includes('att has initiated')) {
            await processCalendarEvents('Pay AT&T', { action: 'delete', monthOffset: 0 });
            return true;
        } else if (body.includes('lowes has initiated')) {
            await processCalendarEvents('Pay Lowes', { action: 'delete', monthOffset: 0 });
            return true;
        } else if (body.includes('eastern bank has initiated')) {
            await processCalendarEvents('Pay Eastern Savings', { action: 'delete', monthOffset: 0 });
            return true;
        } else if (body.includes('sunrun has initiated')) {
            await processCalendarEvents('Sunrun withdrawal', { action: 'delete', monthOffset: 0 });
            return true;
        }
        return false;
    }

    // ✅ Amex card payment
    if (sender.includes('americanexpress.com') && subj.includes('received your payment')) {
        console.log(`💳 Checking for Amex card payments for "${subject}"`);
        // Search next month since Amex reminders are scheduled at start of next month
        await processCalendarEvents('Pay Amex', { action: 'delete', monthOffset: 1 });
        return true;
    }

    // ✅ Chase card payment
    if (sender.includes('chase.com') && subj.includes('your credit card payment is scheduled')) {
        console.log(`🔍 Checking for Chase card payments for "${subject}"`);
        // Search next month since Chase reminders are scheduled at start of next month
        await processCalendarEvents('Pay Chase', { action: 'delete', monthOffset: 1 });
        return true;
    }

    // ✅ Chase mortgage payment
    if (sender.includes('chase.com') && subj.includes('you scheduled your mortgage payment')) {
        console.log(`🏠 Checking for Chase mortgage payments: "${subject}"`);
        // Search next month since mortgage reminders are scheduled at start of next month
        await processCalendarEvents('Pay mortgage', { action: 'delete', monthOffset: 1 });
        return true;
    }

    // ✅ Comcast/Xfinity
    if (sender.includes('chase.com') && subj.includes('transaction with comcast / xfinity')) {
        console.log(`🌐 Checking for Comcast/Xfinity payments: "${subject}"`);
        const amountMatch = subject.match(/\$([\d,]+(?:\.\d{2})?)/);
        if (!amountMatch) {
            console.log(`No dollar amount found in "${subject}"`);
            return false;
        }
        const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
        if (isNaN(amount) || amount < 100 || amount > 200) {
            console.log(`Unexpected Comcast amount $${amount}, skipping.`);
            return false;
        }
        await processCalendarEvents('Comcast / Xfinity Withdrawal', { action: 'delete', monthOffset: 0 });
        return true;
    }

    // ✅ Eversource
    if (sender.includes('chase.com') && subj.includes('transaction with spi*eversource')) {
        console.log(`🔌 Checking for Eversource/Speedpay payments: "${subject}"`);
        const amountMatch = subject.match(/\$([\d,]+(?:\.\d{2})?)/);
        if (!amountMatch) {
            console.log(`No dollar amount found in "${subject}"`);
            return false;
        }
        const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
        if (isNaN(amount)) {
            console.log(`Invalid Eversource amount in "${subject}"`);
            return false;
        }
        await processCalendarEvents('Pay Gas Bill', { action: 'patch', monthOffset: 0, title: `Gas Bill - $${amount}` });
        return true;
    }

    console.log(`📖 Ignoring email from "${from}" and subject "${subject}"`);
    return false;
}

/**
 * Extracts the plain text or HTML body from a Gmail message payload.
 * Handles multipart messages and prefers plain text.
 *
 * @param {Object} message - The Gmail message object.
 * @returns {string} - The extracted email body content.
 */
function extractEmailBody(message) {
    const { payload } = message.data;

    // Helper to decode base64
    const decode = (data) => Buffer.from(data, 'base64').toString('utf8');

    // 1. Try plain text in main payload
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
        return decode(payload.body.data);
    }

    // 2. Try HTML in main payload
    if (payload.mimeType === 'text/html' && payload.body?.data) {
        return decode(payload.body.data);
    }

    // 3. Search in parts
    if (payload.parts) {
        // Prefer plain text
        const plainPart = payload.parts.find(p => p.mimeType === 'text/plain' && p.body?.data);
        if (plainPart) {
            return decode(plainPart.body.data);
        }

        // Fallback to HTML
        const htmlPart = payload.parts.find(p => p.mimeType === 'text/html' && p.body?.data);
        if (htmlPart) {
            return decode(htmlPart.body.data);
        }
    }

    return '';
}

/**
 * Marks a specific Gmail message as read by removing the 'UNREAD' label.
 *
 * @param {Object} params - The parameters.
 * @param {string} params.from - The sender's email address (for logging).
 * @param {string} params.subject - The email subject (for logging).
 * @param {string} params.messageId - The ID of the message to mark as read.
 * @returns {Promise<void>}
 */
async function markMessageAsRead({ from, subject, messageId }) {
    await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
            removeLabelIds: ['UNREAD']
        }
    });
    console.log(`📖 Marked email "${from}" and subject "${subject}" as read.`);
}

/**
 * Updates or deletes Google Calendar events based on transaction details.
 * Searches for events matching a prefix within a specific month range.
 *
 * @param {string} eventPrefix - The prefix to search for in event summaries (e.g., "Pay Amex").
 * @param {Object} options - The options for processing.
 * @param {string} options.action - The action to perform: 'delete' or 'patch'.
 * @param {number} [options.monthOffset=0] - The offset in months from the current date to search (0 = current month, 1 = next month).
 * @param {string} [options.title] - The new title for the event (required if action is 'patch').
 * @returns {Promise<boolean>} - Returns `true` if successful, `false` if an error occurred or no calendar was found.
 */
async function processCalendarEvents(eventPrefix, { action, monthOffset = 0, title }) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 0, 23, 59, 59);

    try {
        const calendarList = await calendar.calendarList.list();
        const targetCal = calendarList.data.items.find(c => c.summary === CALENDAR_NAME);
        if (!targetCal) {
            console.log(`No calendar named "${CALENDAR_NAME}".`);
            return false;
        }

        const eventsRes = await calendar.events.list({
            calendarId: targetCal.id,
            timeMin: monthStart.toISOString(),
            timeMax: monthEnd.toISOString(),
            singleEvents: true, // Expand recurring events into individual instances
        });

        const events = eventsRes.data.items.filter(e => e.summary.startsWith(eventPrefix));
        if (!events.length) {
            console.log(`No "${eventPrefix}" reminders this month.`);
            return false;
        }

        for (const e of events) {
            if (action === 'delete') {
                // For recurring events, use originalStartTime if available, otherwise use start
                const actualStart = e.originalStartTime || e.start;
                const eventDate = actualStart.date || new Date(actualStart.dateTime).toISOString().split('T')[0];
                console.log(`🗑 Deleting "${e.summary}" on ${eventDate}`);
                await calendar.events.delete({ calendarId: targetCal.id, eventId: e.id });
            } else if (action === 'patch') {
                console.log(`✏️ Updating "${e.summary}" → "${title}"`);
                await calendar.events.patch({
                    calendarId: targetCal.id,
                    eventId: e.id,
                    requestBody: { summary: title }
                });
            } else {
                console.log(`⁉️ Unknown action "${action}"`);
            }
        }
        return true;
    } catch (calErr) {
        console.error(`❌ Calendar API error: ${calErr.message}`);
        return false;
    }
}
