import 'dotenv/config';
import { cloudEvent } from '@google-cloud/functions-framework';
import { Firestore } from '@google-cloud/firestore';
import { google } from 'googleapis';

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

        // Create a processing lock to prevent duplicate execution
        const lockKey = `${email}_${startId}_${newHistoryId}`;
        const lockRef = firestore.collection('processing_locks').doc(lockKey);

        try {
            await lockRef.create({ timestamp: Date.now(), ttl: Date.now() + 5000 }); // 5 second TTL
        } catch (err) {
            // ALREADY_EXISTS
            if (err.code === 6) {
                console.log(`🔒 Another instance is processing historyId range ${startId}-${newHistoryId}`);
                return;
            }
            throw err;
        }

        console.log(`🔍 Fetching Gmail history since ${startId}`);

        try {
            // Fetch recent Gmail changes
            const res = await gmail.users.history.list({
                userId: 'me',
                startHistoryId: startId,
            });

            if (!res.data.history) {
                console.log('📬 Gmail History: No changes since last check');
                return;
            }

            console.log(`📬 Gmail History fetched: ${res.data.history.length} items`);

            for (const { messagesAdded = [] } of res.data.history) {
                for (const { message } of messagesAdded) {
                    try {
                        const msg = await gmail.users.messages.get({ userId: 'me', id: message.id });
                        const subjectHeader = msg.data.payload.headers.find(h => h.name === 'Subject');
                        const fromHeader = msg.data.payload.headers.find(h => h.name === 'From');
                        const subject = subjectHeader?.value || '';
                        const from = fromHeader?.value || '';

                        const wasProcessed = await handleTransaction({ from, subject, message: msg });
                        if (wasProcessed) {
                            await markMessageAsRead({ from, subject, messageId: message.id });
                        }
                    } catch (err) {
                        if (err.code === 404) {
                            console.warn(`👻 Skipping missing message: ${message.id}`);
                            continue;
                        }
                        // Rethrow unexpected errors
                        throw err;
                    }
                }
            }

            // Persist the latest historyId and cleanup lock
            await Promise.all([
                docRef.set({ lastHistoryId: newHistoryId }, { merge: true }),
                lockRef.delete()
            ]);
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

async function handleTransaction({ from, subject, message }) {
    const sender = from.toLowerCase();
    const subj = subject.toLowerCase();

    // ✅ Capital One withdrawal notice
    if (sender.includes('capitalone.com') && subj.includes('withdrawal notice')) {
        console.log(`🏦 Checking Capital One withdrawal notice for "${subject}"`);
        const body = extractEmailBody(message).toLowerCase();

        if (body.includes('att has initiated')) {
            await processCalendarEvents('Pay AT&T', { action: 'delete', monthOffset: 1 });
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

function extractEmailBody(message) {
    const { payload } = message.data;

    // Try to get plain text body first
    if (payload.body?.data) {
        return Buffer.from(payload.body.data, 'base64').toString('utf8');
    }

    // Check for multipart content
    if (payload.parts) {
        for (const part of payload.parts) {
            if (part.mimeType === 'text/plain' && part.body?.data) {
                return Buffer.from(part.body.data, 'base64').toString('utf8');
            }
        }
    }

    return '';
}

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

async function processCalendarEvents(eventPrefix, { action, monthOffset = 0, title }) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 0, 23, 59, 59);

    const calendarList = await calendar.calendarList.list();
    const targetCal = calendarList.data.items.find(c => c.summary === CALENDAR_NAME);
    if (!targetCal) {
        console.log(`No calendar named "${CALENDAR_NAME}".`);
        return false;
    }

    const eventsRes = await calendar.events.list({
        calendarId: targetCal.id,
        timeMin: monthStart.toISOString(),
        timeMax: monthEnd.toISOString()
    });

    const events = eventsRes.data.items.filter(e => e.summary.startsWith(eventPrefix));
    if (!events.length) {
        console.log(`No "${eventPrefix}" reminders this month.`);
        return false;
    }

    for (const e of events) {
        if (action === 'delete') {
            console.log(`🗑 Deleting "${e.summary}" on ${e.start.date || e.start.dateTime}`);
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
}
