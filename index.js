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

        // Decide which historyId to start from
        const startId = lastHistoryId || newHistoryId;
        console.log(`🔍 Fetching Gmail history since ${startId}`);

        try {
            // Fetch recent Gmail changes
            const res = await gmail.users.history.list({
                userId: 'me',
                startHistoryId: startId,
            });
            console.log(`📬 Gmail History fetched: ${res.data.history?.length || 0} items`);

            for (const { messagesAdded = [] } of res.data.history) {
                for (const { message } of messagesAdded) {
                    try {
                        const msg = await gmail.users.messages.get({ userId: 'me', id: message.id });
                        const subjectHeader = msg.data.payload.headers.find(h => h.name === 'Subject');
                        const fromHeader = msg.data.payload.headers.find(h => h.name === 'From');
                        const subject = subjectHeader?.value || '';
                        const from = fromHeader?.value || '';

                        await handleTransaction({ from, subject });
                    } catch (err) {
                        if (err.code === 404) {
                            console.warn(`Skipping missing message: ${message.id}`);
                            continue;
                        }
                        // Rethrow unexpected errors
                        throw err;
                    }
                }
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

async function handleTransaction({ from, subject }) {
    const sender = from.toLowerCase();
    const subj = subject.toLowerCase();

    // ✅ Chase card payment
    if (sender.includes('chase.com') && subj.includes('your credit card payment is scheduled')) {
        await handleChaseCardPayment(subject);
        return;
    }

    // ✅ Chase mortgage payment
    if (sender.includes('chase.com') && subj.includes('you scheduled your mortgage payment')) {
        await handleChaseMortgagePayment(subject);
        return;
    }

    // ✅ Comcast/Xfinity
    if (sender.includes('chase.com') && subj.includes('transaction with comcast / xfinity')) {
        await handleXfinityPayment(subject);
        return;
    }

    // ✅ Eversource
    if (sender.includes('chase.com') && subj.includes('transaction with spi*eversource')) {
        await handleEversourcePayment(subject);
        return;
    }

    console.log(`Ignoring email from "${from}" and subject "${subject}"`);
}

async function handleChaseCardPayment(subject) {
    console.log(`🔍 Checking for Chase card payments for "${subject}"`);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const calendarList = await calendar.calendarList.list();
    const targetCal = calendarList.data.items.find(c => c.summary === CALENDAR_NAME);
    if (!targetCal) {
        console.log(`No calendar named "${CALENDAR_NAME}".`);
        return;
    }

    const eventsRes = await calendar.events.list({
        calendarId: targetCal.id,
        timeMin: monthStart.toISOString(),
        timeMax: monthEnd.toISOString()
    });
    const events = eventsRes.data.items.filter(e => e.summary.startsWith('Pay Chase'));
    if (!events.length) {
        console.log('No "Pay Chase" reminders this month.');
        return;
    }

    for (const e of events) {
        console.log(`🗑 Deleting "${e.summary}" on ${e.start.date || e.start.dateTime}`);
        await calendar.events.delete({ calendarId: targetCal.id, eventId: e.id });
    }
}

async function handleChaseMortgagePayment(subject) {
    console.log(`🏠 Checking for Chase mortgage payments: "${subject}"`);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const calendarList = await calendar.calendarList.list();
    const targetCal = calendarList.data.items.find(c => c.summary === CALENDAR_NAME);
    if (!targetCal) {
        console.log(`No calendar named "${CALENDAR_NAME}".`);
        return;
    }

    const eventsRes = await calendar.events.list({
        calendarId: targetCal.id,
        timeMin: monthStart.toISOString(),
        timeMax: monthEnd.toISOString()
    });
    const events = eventsRes.data.items.filter(e => e.summary.startsWith('Pay mortgage'));
    if (!events.length) {
        console.log('No "Pay mortgage" reminders this month.');
        return;
    }

    for (const e of events) {
        console.log(`🗑 Deleting "${e.summary}" on ${e.start.date || e.start.dateTime}`);
        await calendar.events.delete({ calendarId: targetCal.id, eventId: e.id });
    }
}

async function handleXfinityPayment(subject) {
    console.log(`🌐 Checking for Comcast/Xfinity payments: "${subject}"`);
    const amountMatch = subject.match(/\$([\d,]+(?:\.\d{2})?)/);
    if (!amountMatch) {
        console.log(`No dollar amount found in "${subject}"`);
        return;
    }

    const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    if (isNaN(amount) || amount < 100 || amount > 200) {
        console.log(`Unexpected Comcast amount $${amount}, skipping.`);
        return;
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const calendarList = await calendar.calendarList.list();
    const targetCal = calendarList.data.items.find(c => c.summary === CALENDAR_NAME);
    if (!targetCal) {
        console.log(`No calendar named "${CALENDAR_NAME}".`);
        return;
    }

    const eventsRes = await calendar.events.list({
        calendarId: targetCal.id,
        timeMin: monthStart.toISOString(),
        timeMax: monthEnd.toISOString()
    });
    const events = eventsRes.data.items.filter(e => e.summary.startsWith('Comcast / Xfinity Withdrawal'));
    if (!events.length) {
        console.log('No Comcast/Xfinity reminders this month.');
        return;
    }

    for (const e of events) {
        console.log(`🗑 Deleting "${e.summary}" on ${e.start.date || e.start.dateTime}`);
        await calendar.events.delete({ calendarId: targetCal.id, eventId: e.id });
    }
}

async function handleEversourcePayment(subject) {
    console.log(`🔌 Checking for Eversource/Speedpay payments: "${subject}"`);
    const amountMatch = subject.match(/\$([\d,]+(?:\.\d{2})?)/);
    if (!amountMatch) {
        console.log(`No dollar amount found in "${subject}"`);
        return;
    }

    const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    if (isNaN(amount)) {
        console.log(`Invalid Eversource amount in "${subject}"`);
        return;
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const calendarList = await calendar.calendarList.list();
    const targetCal = calendarList.data.items.find(c => c.summary === CALENDAR_NAME);
    if (!targetCal) return console.log(`No calendar named "${CALENDAR_NAME}".`);

    const eventsRes = await calendar.events.list({
        calendarId: targetCal.id,
        timeMin: monthStart.toISOString(),
        timeMax: monthEnd.toISOString()
    });
    const events = eventsRes.data.items.filter(e => e.summary.startsWith('Pay Gas Bill'));
    if (!events.length) {
        console.log('No "Pay Gas Bill" reminders this month.');
        return;
    }

    for (const e of events) {
        const newTitle = `Gas Bill - $${amount}`;
        console.log(`✏️ Updating "${e.summary}" → "${newTitle}"`);
        await calendar.events.patch({
            calendarId: targetCal.id,
            eventId: e.id,
            requestBody: { summary: newTitle }
        });
    }
}
