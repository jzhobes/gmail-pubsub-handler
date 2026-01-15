import 'dotenv/config';
import { cloudEvent } from '@google-cloud/functions-framework';
import { Firestore } from '@google-cloud/firestore';
import { google } from 'googleapis';
import { Readable } from 'stream';
import { checkAndMarkMessageProcessed } from './deduplication.js';

/**
 * Core processor for handling Gmail Pub/Sub events and executing financial transactions.
 */
export class TransactionAutomationService {
  /**
   * @param {Object} [services] - Injected services for testing.
   * @param {Object} [services.firestore]
   * @param {Object} [services.gmail]
   * @param {Object} [services.calendar]
   * @param {Object} [services.drive]
   * @param {Object} [services.drive]
   * @param {Object} [services.nationalGrid]
   * @param {Object} [services.sunrun]
   * @param {Object} [config] - Configuration overrides (default: process.env).
   */
  constructor(services = {}, config = process.env) {
    this.config = config;
    this.calendarName = config.CALENDAR_NAME;

    this.firestore = services.firestore;
    this.gmail = services.gmail;
    this.calendar = services.calendar;
    this.drive = services.drive;
    this.drive = services.drive;
    this.nationalGrid = services.nationalGrid;
    this.sunrun = services.sunrun;

    this.#initializeServices();
  }

  /**
   * Initializes missing services using environment variables.
   *
   * @private
   */
  #initializeServices() {
    const { GMAIL_OAUTH_CREDENTIALS, FIRESTORE_COLLECTION, CALENDAR_NAME } =
      this.config;

    // Check if we have all required services
    const hasAllServices =
      this.firestore && this.gmail && this.calendar && this.drive;

    // If we are missing services, we need credentials to create them
    if (!hasAllServices) {
      if (!GMAIL_OAUTH_CREDENTIALS || !FIRESTORE_COLLECTION || !CALENDAR_NAME) {
        throw new Error(
          '❌ GMAIL_OAUTH_CREDENTIALS, FIRESTORE_COLLECTION, and CALENDAR_NAME env vars are required'
        );
      }

      // Initialize Firestore
      if (!this.firestore) {
        this.firestore = new Firestore();
      }

      // Initialize Google APIs
      if (!this.gmail || !this.calendar || !this.drive) {
        const { client_id, client_secret, refresh_token } = JSON.parse(
          GMAIL_OAUTH_CREDENTIALS
        );
        const auth = new google.auth.OAuth2(client_id, client_secret);
        auth.setCredentials({ refresh_token });

        if (!this.gmail) {
          this.gmail = google.gmail({ version: 'v1', auth });
        }
        if (!this.calendar) {
          this.calendar = google.calendar({ version: 'v3', auth });
        }
        if (!this.drive) {
          this.drive = google.drive({ version: 'v3', auth });
        }
      }
    }
  }

  /**
   * Main entry point for processing a Pub/Sub message.
   *
   * @param {Object} cloudEvent
   */
  async handleEvent(cloudEvent) {
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

      const email = payload.emailAddress || 'me';
      const newHistoryId = payload.historyId;

      // Load last known historyId from Firestore
      const docRef = this.firestore
        .collection(this.config.FIRESTORE_COLLECTION)
        .doc(email);
      const docSnap = await docRef.get();
      const lastHistoryId = docSnap.exists
        ? docSnap.data().lastHistoryId
        : null;

      // Skip if this historyId is not newer than what we've already processed
      if (lastHistoryId && newHistoryId <= lastHistoryId) {
        console.log(
          `⏭️ Skipping ${newHistoryId < lastHistoryId ? 'old' : 'duplicate'} historyId: ${newHistoryId} (last: ${lastHistoryId})`
        );
        return;
      }

      // Decide which historyId to start from
      const startId = lastHistoryId || newHistoryId;

      console.log(`🔍 Fetching Gmail history since ${startId}`);

      try {
        const success = await this.processGmailHistory(startId);
        if (!success) {
          console.log('📬 Gmail History: No changes since last check');
          return;
        }

        // Persist the latest historyId
        await docRef.set({ lastHistoryId: newHistoryId }, { merge: true });
        console.log(`✅ Updated Firestore lastHistoryId → ${newHistoryId}`);
      } catch (apiErr) {
        if (apiErr?.response?.status === 400) {
          console.warn(
            `⚠️ Invalid historyId detected. Resetting baseline. Error: ${apiErr.message}`
          );
          try {
            const profile = await this.gmail.users.getProfile({ userId: 'me' });
            const resetHistoryId = profile.data.historyId;
            await docRef.set(
              { lastHistoryId: resetHistoryId },
              { merge: true }
            );
            console.log(`✅ Baseline reset → ${resetHistoryId}`);
          } catch (resetErr) {
            console.error(`❌ Failed to reset baseline: ${resetErr.message}`);
          }
        } else {
          console.error(`❌ Gmail API error: ${apiErr.message}`);
        }
      }
    } catch (e) {
      console.error(`❌ Error processing Gmail Pub/Sub message: ${e.message}`);
    }
  }

  /**
   * Fetches and processes Gmail history.
   *
   * @param {string} startHistoryId
   * @returns {Promise<boolean>}
   */
  async processGmailHistory(startHistoryId) {
    const res = await this.gmail.users.history.list({
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
          const isNew = await checkAndMarkMessageProcessed(
            this.firestore,
            message.id
          );
          if (!isNew) {
            console.log(`⏭️ Skipping duplicate message: ${message.id}`);
            continue;
          }

          const msg = await this.gmail.users.messages.get({
            userId: 'me',
            id: message.id,
          });
          const subject =
            msg.data.payload.headers.find((h) => h.name === 'Subject')?.value ||
            '';
          const from =
            msg.data.payload.headers.find((h) => h.name === 'From')?.value ||
            '';

          const wasProcessed = await this.handleTransaction({
            from,
            subject,
            message: msg,
          });
          if (wasProcessed) {
            await this.markMessageAsRead({
              from,
              subject,
              messageId: message.id,
            });
          }
        } catch (e) {
          if (e.code === 404) {
            console.warn(`👻 Skipping missing message: ${message.id}`);
            continue;
          }
          console.error(
            `❌ Error processing message ${message.id}: ${e.message}`
          );
          continue;
        }
      }
    }

    return true;
  }

  /**
   * Analyzes an email to detect and handle specific financial transactions.
   *
   * @param {Object} params
   * @returns {Promise<boolean>}
   */
  async handleTransaction({ from, subject, message }) {
    const sender = from.toLowerCase();
    const subj = subject.toLowerCase();
    const body = extractEmailBody(message).toLowerCase();

    // ✅ National Grid Bill
    // Check subject AND body for original sender (handles forwards)
    if (
      (sender.includes('nationalgridus.com') ||
        /from:.*nationalgridus\.com/.test(body)) &&
      subj.includes('national grid bill')
    ) {
      console.log(`⚡ Checking National Grid bill for "${subject}"`);
      try {
        if (!this.nationalGrid) {
          const { default: NationalGridClient } =
            await import('./NationalGridClient.js');
          this.nationalGrid = new NationalGridClient();
        }

        const billData = await this.nationalGrid.getCurrentBill();
        await this.uploadToDrive(billData, 'House/National Grid Bills');
        return true;
      } catch (error) {
        console.error(
          `❌ Failed to process National Grid bill: ${error.message}`
        );
        return false;
      }
    }

    // ✅ Sunrun Bill
    // Check subject AND body for original sender (handles forwards)
    if (
      (sender.includes('sunrun.com') || /from:.*sunrun\.com/.test(body)) &&
      subj.includes('sunrun bill')
    ) {
      console.log(`☀️ Checking Sunrun bill for "${subject}"`);
      try {
        if (!this.sunrun) {
          const { default: SunrunClient } = await import('./SunrunClient.js');
          this.sunrun = new SunrunClient();
        }

        const billData = await this.sunrun.getBillFromMessage(
          message,
          this.gmail
        );
        if (!billData) {
          return false;
        }

        await this.uploadToDrive(billData, 'House/Sunrun Bills');
        return true;
      } catch (error) {
        console.error(`❌ Failed to process Sunrun bill: ${error.message}`);
        return false;
      }
    }

    // ✅ Capital One withdrawal notice
    if (
      sender.includes('capitalone.com') &&
      subj.includes('withdrawal notice')
    ) {
      console.log(`🏦 Checking Capital One withdrawal notice for "${subject}"`);
      const body = extractEmailBody(message).toLowerCase();

      if (body.includes('att has initiated')) {
        await this.processCalendarEvents('Pay AT&T', {
          action: 'delete',
          monthOffset: 0,
        });
        return true;
      } else if (body.includes('lowes has initiated')) {
        await this.processCalendarEvents('Pay Lowes', {
          action: 'delete',
          monthOffset: 0,
        });
        return true;
      } else if (body.includes('eastern bank has initiated')) {
        await this.processCalendarEvents('Pay Eastern Savings', {
          action: 'delete',
          monthOffset: 0,
        });
        return true;
      } else if (body.includes('sunrun has initiated')) {
        await this.processCalendarEvents('Sunrun withdrawal', {
          action: 'delete',
          monthOffset: 0,
        });
        return true;
      }
      return false;
    }

    // ✅ Amex card payment
    if (
      sender.includes('americanexpress.com') &&
      subj.includes('received your payment')
    ) {
      console.log(`💳 Checking for Amex card payments for "${subject}"`);
      await this.processCalendarEvents('Pay Amex', {
        action: 'delete',
        monthOffset: 1,
      });
      return true;
    }

    // ✅ Chase card payment
    if (
      sender.includes('chase.com') &&
      subj.includes('your credit card payment is scheduled')
    ) {
      console.log(`🔍 Checking for Chase card payments for "${subject}"`);
      await this.processCalendarEvents('Pay Chase', {
        action: 'delete',
        monthOffset: 1,
      });
      return true;
    }

    // ✅ Chase mortgage payment
    if (
      sender.includes('chase.com') &&
      subj.includes('you scheduled your mortgage payment')
    ) {
      console.log(`🏠 Checking for Chase mortgage payments: "${subject}"`);
      await this.processCalendarEvents('Pay mortgage', {
        action: 'delete',
        monthOffset: 1,
      });
      return true;
    }

    // ✅ Comcast/Xfinity
    if (
      sender.includes('chase.com') &&
      subj.includes('transaction with comcast / xfinity')
    ) {
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
      await this.processCalendarEvents('Comcast / Xfinity Withdrawal', {
        action: 'delete',
        monthOffset: 0,
      });
      return true;
    }

    // ✅ Eversource
    if (
      sender.includes('chase.com') &&
      subj.includes('transaction with spi*eversource')
    ) {
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
      await this.processCalendarEvents('Pay Gas Bill', {
        action: 'patch',
        monthOffset: 0,
        title: `Gas Bill - $${amount}`,
      });
      return true;
    }

    console.log(`📖 Ignoring email from "${from}" and subject "${subject}"`);
    return false;
  }

  /**
   * Uploads a file to Google Drive.
   *
   * @param {Object} fileData
   * @param {string} folderPath
   */
  async uploadToDrive(fileData, folderPath) {
    const folders = folderPath.split('/');
    let parentId = null; // root

    // Find or create folders
    for (const folderName of folders) {
      parentId = await this.#findOrCreateFolder(folderName, parentId);
    }

    const media = {
      mimeType: 'application/pdf',
      body: Readable.from(fileData.buffer),
    };

    try {
      // Check if file exists
      const existingFiles = await this.drive.files.list({
        q: `name = '${fileData.fileName}' and '${parentId}' in parents and trashed = false`,
        fields: 'files(id)',
        spaces: 'drive',
      });

      const fileId = existingFiles.data.files[0]?.id;
      const commonParams = {
        media,
        fields: 'id',
      };

      if (fileId) {
        // Update existing file
        const file = await this.drive.files.update({
          ...commonParams,
          fileId: fileId,
        });
        console.log(
          `[ACTION] ☁️ Overwrote existing "${fileData.fileName}" in Drive (ID: ${file.data.id})`
        );
      } else {
        // Create new file
        const file = await this.drive.files.create({
          ...commonParams,
          resource: {
            name: fileData.fileName,
            parents: [parentId],
          },
        });
        console.log(
          `[ACTION] ☁️ Uploaded new "${fileData.fileName}" to Drive (ID: ${file.data.id})`
        );
      }
    } catch (error) {
      console.error(`❌ Drive upload failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Helper to find or create a folder.
   *
   * @private
   */
  async #findOrCreateFolder(name, parentId) {
    const query = `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false ${parentId ? `and '${parentId}' in parents` : "and 'root' in parents"}`;

    try {
      const res = await this.drive.files.list({
        q: query,
        fields: 'files(id, name)',
        spaces: 'drive',
      });

      if (res.data.files.length > 0) {
        return res.data.files[0].id;
      }

      // Create folder
      const fileMetadata = {
        name: name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : [],
      };

      const file = await this.drive.files.create({
        resource: fileMetadata,
        fields: 'id',
      });

      console.log(`[ACTION] 📁 Created folder "${name}" (ID: ${file.data.id})`);
      return file.data.id;
    } catch (error) {
      console.error(
        `❌ Error finding/creating folder "${name}": ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Marks a message as read.
   *
   * @param {Object} params
   */
  async markMessageAsRead({ from, subject, messageId }) {
    await this.gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        removeLabelIds: ['UNREAD'],
      },
    });
    console.log(`[ACTION] 📖 Marked email "${from}" and subject "${subject}" as read.`);
  }

  /**
   * Updates or deletes calendar events.
   *
   * @param {string} eventPrefix
   * @param {Object} options
   */
  async processCalendarEvents(eventPrefix, { action, monthOffset = 0, title }) {
    const now = new Date();
    const monthStart = new Date(
      now.getFullYear(),
      now.getMonth() + monthOffset,
      1
    );
    const monthEnd = new Date(
      now.getFullYear(),
      now.getMonth() + monthOffset + 1,
      0,
      23,
      59,
      59
    );

    try {
      const calendarList = await this.calendar.calendarList.list();
      const targetCal = calendarList.data.items.find(
        (c) => c.summary === this.calendarName
      );
      if (!targetCal) {
        console.log(`No calendar named "${this.calendarName}".`);
        return false;
      }

      const eventsRes = await this.calendar.events.list({
        calendarId: targetCal.id,
        timeMin: monthStart.toISOString(),
        timeMax: monthEnd.toISOString(),
        singleEvents: true,
      });

      const events = eventsRes.data.items.filter((e) =>
        e.summary.startsWith(eventPrefix)
      );
      if (!events.length) {
        console.log(`No "${eventPrefix}" reminders this month.`);
        return false;
      }

      for (const e of events) {
        if (action === 'delete') {
          const actualStart = e.originalStartTime || e.start;
          const eventDate =
            actualStart.date ||
            new Date(actualStart.dateTime).toISOString().split('T')[0];
          console.log(`[ACTION] 🗑 Deleting "${e.summary}" on ${eventDate}`);
          await this.calendar.events.delete({
            calendarId: targetCal.id,
            eventId: e.id,
          });
        } else if (action === 'patch') {
          console.log(`[ACTION] ✏️ Updating "${e.summary}" → "${title}"`);
          await this.calendar.events.patch({
            calendarId: targetCal.id,
            eventId: e.id,
            requestBody: { summary: title },
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
}

/**
 * Helper to extract email body.
 */
function extractEmailBody(message) {
  const payload = message?.data?.payload;
  if (!payload) {
    return '';
  }

  const decode = (data) => Buffer.from(data, 'base64').toString('utf8');

  // Recursive function to find text content in nested parts
  const findTextContent = (part) => {
    // Check if this part has text content directly
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return decode(part.body.data);
    }

    if (part.mimeType === 'text/html' && part.body?.data) {
      return decode(part.body.data);
    }

    // Recursively search nested parts
    if (part.parts) {
      for (const subPart of part.parts) {
        const content = findTextContent(subPart);
        if (content) {
          return content;
        }
      }
    }

    return '';
  };

  return findTextContent(payload);
}

// Initialize service outside the handler to reuse it across invocations
const automationService = new TransactionAutomationService();

// Main entry point
const gmailPubSubHandler = (event) => automationService.handleEvent(event);

// Register the function with the Functions Framework
cloudEvent('gmailPubSubHandler', gmailPubSubHandler);
