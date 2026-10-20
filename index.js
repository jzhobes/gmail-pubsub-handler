import 'dotenv/config';
import { cloudEvent } from '@google-cloud/functions-framework';
import { Firestore } from '@google-cloud/firestore';
import { google } from 'googleapis';
import { Readable } from 'stream';
import { checkAndMarkMessageProcessed } from './deduplication.js';
import { logger } from './logger.js';

/**
 * @typedef {Object} TransactionContext
 * @property {string} from - Sender header string.
 * @property {string} subject - Email subject line.
 * @property {string} subj - Lowercased subject line.
 * @property {string} body - Lowercased email body text.
 * @property {Object} message - Gmail message object.
 */

/**
 * @typedef {Object} TransactionRule
 * @property {string} name - Human-readable name of the rule.
 * @property {(context: TransactionContext) => boolean} matches - Determines if the rule applies to the email.
 * @property {(context: TransactionContext, service: TransactionAutomationService) => Promise<boolean>} execute - Executes the transaction action.
 */

/**
 * Default transaction routing rules.
 * @type {Array<TransactionRule>}
 */
export const transactionRules = [
  {
    name: 'National Grid Bill',
    matches: ({ from, subj, body }) =>
      (isFromDomain(from, 'nationalgridus.com') || /from:.*@(?:[a-zA-Z0-9-]+\.)*nationalgridus\.com\b/i.test(body)) &&
      subj.includes('national grid bill'),
    execute: async ({ subject }, service) => {
      logger.log(`⚡ Checking National Grid bill for "${subject}"`);
      try {
        if (!service.nationalGrid) {
          const { default: NationalGridClient } = await import('./NationalGridClient.js');
          service.nationalGrid = new NationalGridClient();
        }

        const billData = await service.nationalGrid.getCurrentBill();
        await service.uploadToDrive(billData, 'House/National Grid Bills');
        return true;
      } catch (e) {
        logger.error(`❌ Failed to process National Grid bill: ${e.message}`);
        return false;
      }
    },
  },
  {
    name: 'Sunrun Bill',
    matches: ({ from, subj, body }) =>
      (isFromDomain(from, 'sunrun.com') || /from:.*@(?:[a-zA-Z0-9-]+\.)*sunrun\.com\b/i.test(body)) &&
      subj.includes('sunrun bill'),
    execute: async ({ subject, message }, service) => {
      logger.log(`☀️ Checking Sunrun bill for "${subject}"`);
      try {
        if (!service.sunrun) {
          const { default: SunrunClient } = await import('./SunrunClient.js');
          service.sunrun = new SunrunClient();
        }

        const billData = await service.sunrun.getBillFromMessage(message, service.gmail);
        if (!billData) {
          return false;
        }

        await service.uploadToDrive(billData, 'House/Sunrun Bills');
        return true;
      } catch (e) {
        logger.error(`❌ Failed to process Sunrun bill: ${e.message}`);
        return false;
      }
    },
  },
  {
    name: 'Capital One Withdrawal Notice',
    matches: ({ from, subj }) => isFromDomain(from, 'capitalone.com') && subj.includes('withdrawal notice'),
    execute: async ({ subject, body }, service) => {
      logger.log(`🏦 Checking Capital One withdrawal notice for "${subject}"`);

      if (body.includes('att has initiated')) {
        return await service.processCalendarEvents('Pay AT&T', {
          action: 'delete',
          monthOffset: 0,
        });
      } else if (body.includes('lowes has initiated')) {
        return await service.processCalendarEvents('Pay Lowes', {
          action: 'delete',
          monthOffset: 0,
        });
      } else if (body.includes('eastern bank has initiated')) {
        return await service.processCalendarEvents('Pay Eastern Savings', {
          action: 'delete',
          monthOffset: 0,
        });
      } else if (body.includes('sunrun has initiated')) {
        return await service.processCalendarEvents('Sunrun withdrawal', {
          action: 'delete',
          monthOffset: 0,
        });
      } else if (body.includes('verizon has initiated')) {
        return await service.processCalendarEvents('Verizon withdrawal', {
          action: 'delete',
          monthOffset: 0,
        });
      } else if (body.includes('comcast-xfinity has initiated')) {
        return await service.checkComcastPayment(body);
      }
      return false;
    },
  },
  {
    name: 'Amex Card Payment',
    matches: ({ from, subj }) => isFromDomain(from, 'americanexpress.com') && subj.includes('received your payment'),
    execute: async ({ subject }, service) => {
      logger.log(`💳 Checking for Amex card payments for "${subject}"`);
      return await service.processCalendarEvents('Pay Amex', {
        action: 'delete',
        monthOffset: 1,
      });
    },
  },
  {
    name: 'Chase Card Payment',
    matches: ({ from, subj }) =>
      isFromDomain(from, 'chase.com') && subj.includes('your credit card payment is scheduled'),
    execute: async ({ subject }, service) => {
      logger.log(`🔍 Checking for Chase card payments for "${subject}"`);
      return await service.processCalendarEvents('Pay Chase', {
        action: 'delete',
        monthOffset: 1,
      });
    },
  },
  {
    name: 'Chase Mortgage Payment',
    matches: ({ from, subj }) =>
      isFromDomain(from, 'chase.com') && subj.includes('you scheduled your mortgage payment'),
    execute: async ({ subject }, service) => {
      logger.log(`🏠 Checking for Chase mortgage payments: "${subject}"`);
      return await service.processCalendarEvents('Pay mortgage', {
        action: 'delete',
        monthOffset: 1,
      });
    },
  },
  {
    name: 'Chase Checking Transfer',
    matches: ({ from, subj }) =>
      isFromDomain(from, 'chase.com') && subj.startsWith('you sent $') && subj.includes(' from account ending in'),
    execute: async ({ subject, body }, service) => {
      logger.log(`🏦 Checking Chase transfer alert: "${subject}"`);

      if (/\blowes\b/.test(body)) {
        return await service.processCalendarEvents('Pay Lowes', {
          action: 'delete',
          monthOffset: 0,
        });
      }
      return false;
    },
  },
  {
    name: 'Chase Comcast Payment',
    matches: ({ from, subj }) => isFromDomain(from, 'chase.com') && subj.includes('transaction with comcast / xfinity'),
    execute: async ({ subject }, service) => {
      return await service.checkComcastPayment(subject);
    },
  },
  {
    name: 'Chase Eversource Payment',
    matches: ({ from, subj }) => isFromDomain(from, 'chase.com') && subj.includes('transaction with spi*eversource'),
    execute: async ({ subject }, service) => {
      logger.log(`🔌 Checking for Eversource/Speedpay payments: "${subject}"`);
      const amountMatch = subject.match(/\$([\d,]+(?:\.\d{2})?)/);
      if (!amountMatch) {
        logger.log(`No dollar amount found in "${subject}"`);
        return false;
      }
      const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
      if (isNaN(amount)) {
        logger.log(`Invalid Eversource amount in "${subject}"`);
        return false;
      }
      return await service.processCalendarEvents('Pay Gas Bill', {
        action: 'patch',
        monthOffset: 0,
        title: `Gas Bill - $${amount}`,
      });
    },
  },
];

/**
 * Core processor for handling Gmail Pub/Sub events and executing financial transactions.
 */
export class TransactionAutomationService {
  /**
   * @param {Object} [services] - Injected services for testing.
   * @param {Firestore} [services.firestore]
   * @param {import('googleapis').gmail_v1.Gmail} [services.gmail]
   * @param {import('googleapis').calendar_v3.Calendar} [services.calendar]
   * @param {import('googleapis').drive_v3.Drive} [services.drive]
   * @param {import('./NationalGridClient.js').default} [services.nationalGrid]
   * @param {import('./SunrunClient.js').default} [services.sunrun]
   * @param {Array<Object>} [services.rules] - Optional custom transaction rules.
   * @param {Object} [config] - Configuration overrides (default: process.env).
   */
  constructor(services = {}, config = process.env) {
    this.config = config;
    this.calendarName = config.CALENDAR_NAME;

    this.firestore = services.firestore;
    this.gmail = services.gmail;
    this.calendar = services.calendar;
    this.drive = services.drive;
    this.nationalGrid = services.nationalGrid;
    this.sunrun = services.sunrun;
    this.rules = services.rules || transactionRules;

    this.#initializeServices();
  }

  /**
   * Initializes missing services using environment variables.
   *
   * @private
   */
  #initializeServices() {
    const { GMAIL_OAUTH_CREDENTIALS, FIRESTORE_COLLECTION, CALENDAR_NAME } = this.config;

    // Check if we have all required services
    const hasAllServices = this.firestore && this.gmail && this.calendar && this.drive;

    // If we are missing services, we need credentials to create them
    if (!hasAllServices) {
      if (!GMAIL_OAUTH_CREDENTIALS || !FIRESTORE_COLLECTION || !CALENDAR_NAME) {
        throw new Error('❌ GMAIL_OAUTH_CREDENTIALS, FIRESTORE_COLLECTION, and CALENDAR_NAME env vars are required');
      }

      // Initialize Firestore
      if (!this.firestore) {
        this.firestore = new Firestore();
      }

      // Initialize Google APIs
      if (!this.gmail || !this.calendar || !this.drive) {
        const { client_id, client_secret, refresh_token } = JSON.parse(GMAIL_OAUTH_CREDENTIALS);
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
        logger.warn('⚠️ No message data found.');
        return;
      }

      // Decode Base64 → JSON
      const dataStr = Buffer.from(message.data, 'base64').toString('utf8');
      const payload = JSON.parse(dataStr);
      logger.log(`📩 Gmail Push payload: ${JSON.stringify(payload)}`);

      const email = payload.emailAddress || 'me';
      const newHistoryId = payload.historyId;

      // Load last known historyId from Firestore
      const docRef = this.firestore.collection(this.config.FIRESTORE_COLLECTION).doc(email);
      const docSnap = await docRef.get();
      const lastHistoryId = docSnap.exists ? docSnap.data().lastHistoryId : null;

      // Skip if this historyId is not newer than what we've already processed
      if (lastHistoryId !== null && lastHistoryId !== undefined && BigInt(newHistoryId) <= BigInt(lastHistoryId)) {
        logger.log(
          `⏭️ Skipping ${BigInt(newHistoryId) < BigInt(lastHistoryId) ? 'old' : 'duplicate'} historyId: ${newHistoryId} (last: ${lastHistoryId})`
        );
        return;
      }

      // Decide which historyId to start from
      const startId = lastHistoryId || newHistoryId;

      logger.log(`🔍 Fetching Gmail history since ${startId}`);

      try {
        const success = await this.processGmailHistory(startId);
        if (!success) {
          logger.log('📬 Gmail History: No changes since last check');
        }

        // Persist the latest historyId
        await docRef.set({ lastHistoryId: newHistoryId }, { merge: true });
        logger.log(`✅ Updated Firestore lastHistoryId → ${newHistoryId}`);
      } catch (apiErr) {
        if (apiErr?.response?.status === 400) {
          logger.warn(`⚠️ Invalid historyId detected. Resetting baseline. Error: ${apiErr.message}`);
          try {
            const profile = await this.gmail.users.getProfile({ userId: 'me' });
            const resetHistoryId = profile.data.historyId;
            await docRef.set({ lastHistoryId: resetHistoryId }, { merge: true });
            logger.log(`✅ Baseline reset → ${resetHistoryId}`);
          } catch (resetErr) {
            logger.error(`❌ Failed to reset baseline: ${resetErr.message}`);
            throw resetErr;
          }
        } else {
          logger.error(`❌ Gmail API error: ${apiErr.message}`);
          throw apiErr;
        }
      }
    } catch (e) {
      logger.error(`❌ Error processing Gmail Pub/Sub message: ${e.message}`);
      // Re-throw error to trigger Pub/Sub retry
      throw e;
    }
  }

  /**
   * Fetches and processes Gmail history.
   *
   * @param {string} startHistoryId
   * @returns {Promise<boolean>}
   */
  async processGmailHistory(startHistoryId) {
    let pageToken = undefined;
    let hasMore = true;
    let totalMessages = 0;

    while (hasMore) {
      const pageResults = await this.processHistoryPage(startHistoryId, pageToken);
      const { processedCount, nextPageToken, historyFound } = pageResults;

      if (!historyFound) {
        if (!pageToken) {
          // No history on first page
          return false;
        }
        // No more history
        break;
      }

      totalMessages += processedCount;
      pageToken = nextPageToken;
      hasMore = !!nextPageToken;
    }

    return totalMessages > 0;
  }

  /**
   * Fetches and processes a single page of history items.
   *
   * @param {string} startHistoryId
   * @param {string} [pageToken]
   * @returns {Promise<{processedCount: number, nextPageToken: string|undefined, historyFound: boolean}>}
   */
  async processHistoryPage(startHistoryId, pageToken) {
    const res = await this.gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      pageToken,
    });

    const historyItems = res.data.history;
    if (!historyItems?.length) {
      return {
        processedCount: 0,
        nextPageToken: undefined,
        historyFound: false,
      };
    }

    logger.log(`📬 Gmail History fetched: ${historyItems.length} items (Page token: ${pageToken || 'start'})`);

    let processedCount = 0;

    for (const { messagesAdded = [] } of historyItems) {
      for (const { message } of messagesAdded) {
        try {
          // Atomic deduplication: mark as processed BEFORE taking any action.
          // This prevents race conditions if multiple pub/sub notifications arrive at once.
          const isNewMessage = await checkAndMarkMessageProcessed(this.firestore, message.id);

          if (!isNewMessage) {
            logger.log(`⏭️ Skipping already processed message: ${message.id}`);
            continue;
          }

          const msg = await this.gmail.users.messages.get({
            userId: 'me',
            id: message.id,
          });
          const subject = msg.data.payload.headers.find((h) => h.name === 'Subject')?.value || '';
          const from = msg.data.payload.headers.find((h) => h.name === 'From')?.value || '';

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

          processedCount++;
        } catch (e) {
          if (e.code === 404) {
            logger.warn(`👻 Skipping missing message: ${message.id}`);
            continue;
          }
          // Remove deduplication doc so this failed message can be retried on next attempt
          try {
            await this.firestore.collection('processed_messages').doc(message.id).delete();
          } catch (delErr) {
            logger.warn(`⚠️ Failed to clear deduplication lock for ${message.id}: ${delErr.message}`);
          }
          logger.error(`❌ Error processing message ${message.id}: ${e.message}`);
          throw e;
        }
      }
    }

    return {
      processedCount,
      nextPageToken: res.data.nextPageToken,
      historyFound: true,
    };
  }

  /**
   * Analyzes an email to detect and handle specific financial transactions.
   *
   * @param {Object} params
   * @param {string} params.from
   * @param {string} params.subject
   * @param {Object} params.message
   * @returns {Promise<boolean>}
   */
  async handleTransaction({ from, subject, message }) {
    const subj = (subject || '').toLowerCase();
    const body = extractEmailBody(message).toLowerCase();
    const context = { from, subject, subj, body, message };

    for (const rule of this.rules) {
      if (rule.matches(context)) {
        return await rule.execute(context, this);
      }
    }

    logger.log(`📖 Ignoring email from "${from}" and subject "${subject}"`);
    return false;
  }

  /**
   * Helper to process Comcast payment detection logic.
   *
   * @param {string} text The text to search for the amount (body or subject).
   * @returns {Promise<boolean>}
   */
  async checkComcastPayment(text) {
    logger.log(`🌐 Checking for Comcast/Xfinity payments: "${text}"`);
    const amountMatch = text.match(/\$([\d,]+(?:\.\d{2})?)/);
    if (!amountMatch) {
      logger.log(`No dollar amount found in "${text}"`);
      return false;
    }
    const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    if (isNaN(amount) || amount < 100 || amount > 200) {
      logger.log(`Unexpected Comcast amount $${amount}, skipping.`);
      return false;
    }
    return await this.processCalendarEvents('Comcast / Xfinity Withdrawal', {
      action: 'delete',
      monthOffset: 0,
    });
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
        logger.log(`[ACTION] ☁️ Overwrote existing "${fileData.fileName}" in Drive (ID: ${file.data.id})`);
      } else {
        // Create new file
        const file = await this.drive.files.create({
          ...commonParams,
          resource: {
            name: fileData.fileName,
            parents: [parentId],
          },
        });
        logger.log(`[ACTION] ☁️ Uploaded new "${fileData.fileName}" to Drive (ID: ${file.data.id})`);
      }
    } catch (e) {
      logger.error(`❌ Drive upload failed: ${e.message}`);
      throw e;
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

      logger.log(`[ACTION] 📁 Created folder "${name}" (ID: ${file.data.id})`);
      return file.data.id;
    } catch (error) {
      logger.error(`❌ Error finding/creating folder "${name}": ${error.message}`);
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
    logger.log(`[ACTION] 📖 Marked email "${from}" and subject "${subject}" as read.`);
  }

  /**
   * Updates or deletes calendar events.
   *
   * @param {string} eventPrefix
   * @param {Object} options
   */
  async processCalendarEvents(eventPrefix, { action, monthOffset = 0, title }) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 0, 23, 59, 59);

    try {
      const calendarList = await this.calendar.calendarList.list();
      const targetCal = calendarList.data.items.find((c) => c.summary === this.calendarName);
      if (!targetCal) {
        logger.log(`No calendar named "${this.calendarName}".`);
        return false;
      }

      const eventsRes = await this.calendar.events.list({
        calendarId: targetCal.id,
        timeMin: monthStart.toISOString(),
        timeMax: monthEnd.toISOString(),
        singleEvents: true,
      });

      const events = eventsRes.data.items.filter((e) => e.summary.startsWith(eventPrefix));
      if (!events.length) {
        logger.log(`No "${eventPrefix}" reminders this month.`);
        return false;
      }

      for (const e of events) {
        if (action === 'delete') {
          const actualStart = e.originalStartTime || e.start;
          const eventDate = actualStart.date || new Date(actualStart.dateTime).toISOString().split('T')[0];
          logger.log(`[ACTION] 🗑 Deleting "${e.summary}" on ${eventDate}`);
          await this.calendar.events.delete({
            calendarId: targetCal.id,
            eventId: e.id,
          });
        } else if (action === 'patch') {
          logger.log(`[ACTION] ✏️ Updating "${e.summary}" → "${title}"`);
          await this.calendar.events.patch({
            calendarId: targetCal.id,
            eventId: e.id,
            requestBody: { summary: title },
          });
        } else {
          logger.log(`⁉️ Unknown action "${action}"`);
        }
      }
      return true;
    } catch (calErr) {
      logger.error(`❌ Calendar API error: ${calErr.message}`);
      return false;
    }
  }
}

/**
 * Checks if the sender email address matches the specified domain or its subdomains.
 *
 * @param {string} from - The From header string (e.g., 'Chase <no.reply.alerts@chase.com>' or 'no-reply@chase.com').
 * @param {string} domain - The domain to check against (e.g., 'chase.com').
 * @returns {boolean} True if the sender email domain exactly matches or is a subdomain of the target domain.
 */
export function isFromDomain(from, domain) {
  if (!from || typeof from !== 'string' || !domain || typeof domain !== 'string') {
    return false;
  }
  const match = from.match(/<([^>]+)>/) || [null, from];
  const email = (match[1] || '')
    .replace(/["']/g, '')
    .replace(/\s*\(.*?\)$/, '')
    .trim()
    .toLowerCase();
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) {
    return false;
  }
  const senderDomain = email.slice(atIndex + 1);
  const targetDomain = domain.toLowerCase().replace(/^\.+/, '');
  return senderDomain === targetDomain || senderDomain.endsWith(`.${targetDomain}`);
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
