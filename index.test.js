import { jest } from '@jest/globals';
import { TransactionAutomationService, isFromDomain, transactionRules } from './index.js';

// Mock Google APIs (Calendar, Drive, Gmail)
const mockCalendar = {
  calendarList: { list: jest.fn() },
  events: { list: jest.fn(), delete: jest.fn(), patch: jest.fn() },
};

const mockDrive = {
  files: {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn().mockResolvedValue({ data: { id: 'updated_file_id' } }),
  },
};

const mockGmail = {
  users: {
    messages: {
      get: jest.fn(),
      modify: jest.fn(),
      list: jest.fn(),
    },
    history: { list: jest.fn() },
    getProfile: jest.fn(),
  },
};

const mockFirestore = {
  collection: jest.fn().mockReturnThis(),
  doc: jest.fn().mockReturnThis(),
  get: jest.fn(),
  set: jest.fn(),
  create: jest.fn(),
  delete: jest.fn(),
};

describe('Transaction Handler Logic', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();

    // Instantiate service with mocks
    service = new TransactionAutomationService(
      {
        calendar: mockCalendar,
        drive: mockDrive,
        gmail: mockGmail,
        firestore: mockFirestore,
      },
      {
        CALENDAR_NAME: 'Test Calendar',
        GMAIL_OAUTH_CREDENTIALS: '{}',
        FIRESTORE_COLLECTION: 'gmail-history',
      }
    );

    // Default Calendar Mock Behavior
    mockCalendar.calendarList.list.mockResolvedValue({
      data: { items: [{ summary: 'Test Calendar', id: 'cal_123' }] },
    });
    mockCalendar.events.list.mockResolvedValue({ data: { items: [] } });
  });

  describe('National Grid', () => {
    it('downloads bill and uploads to Drive', async () => {
      // Mock NationalGridClient
      const mockGetCurrentBill = jest.fn().mockResolvedValue({
        buffer: Buffer.from('fake-pdf'),
        fileName: 'bill.pdf',
      });

      // Re-instantiate with NationalGridClient mock
      service = new TransactionAutomationService(
        {
          calendar: mockCalendar,
          drive: mockDrive,
          gmail: mockGmail,
          nationalGrid: { getCurrentBill: mockGetCurrentBill },
        },
        {
          CALENDAR_NAME: 'Test Calendar',
          GMAIL_OAUTH_CREDENTIALS: '{}',
          FIRESTORE_COLLECTION: 'gmail-history',
        }
      );

      // Mock Drive behavior
      mockDrive.files.list
        .mockResolvedValueOnce({ data: { files: [{ id: 'folder_root' }] } }) // House
        .mockResolvedValueOnce({ data: { files: [{ id: 'folder_ng' }] } }) // National Grid Bills
        .mockResolvedValueOnce({ data: { files: [] } }); // check if file exists
      mockDrive.files.create.mockResolvedValue({ data: { id: 'file_456' } });

      const result = await service.handleTransaction({
        from: 'customerservice@nationalgridus.com',
        subject: 'Your National Grid bill is ready',
        message: {},
      });

      expect(result).toBe(true);
      expect(mockGetCurrentBill).toHaveBeenCalled();
      expect(mockDrive.files.create).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: expect.objectContaining({ name: 'bill.pdf' }),
        })
      );
    });

    // Remove skip to run integration test.
    it.skip('INTEGRATION: actually downloads bill and uploads to Drive', async () => {
      // Ensure .env has valid credentials before running this!
      const realService = new TransactionAutomationService();

      // Search for the most recent National Grid bill email
      const searchResponse = await realService.gmail.users.messages.list({
        userId: 'me',
        q: 'subject:"national grid bill"',
        maxResults: 1,
      });

      if (!searchResponse?.data?.messages?.length) {
        throw new Error('No National Grid bill emails found in Gmail. Send yourself a test email first.');
      }

      const messageId = searchResponse.data.messages[0].id;
      const msg = await realService.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
      });

      const subject = msg.data.payload.headers.find((h) => h.name === 'Subject')?.value || '';
      const from = msg.data.payload.headers.find((h) => h.name === 'From')?.value || '';

      const result = await realService.handleTransaction({
        from,
        subject,
        message: msg,
      });

      expect(result).toBe(true);
    }, 10000); // Increased timeout for real network requests
  });

  describe('Sunrun', () => {
    it('extracts PDF attachment and uploads to Drive', async () => {
      // Mock Gmail attachment extraction
      const mockAttachmentData = Buffer.from('fake-sunrun-pdf');
      mockGmail.users.messages = {
        ...mockGmail.users.messages,
        attachments: {
          get: jest.fn().mockResolvedValue({
            data: {
              data: mockAttachmentData.toString('base64'),
            },
          }),
        },
      };

      // Mock Drive behavior
      mockDrive.files.list
        .mockResolvedValueOnce({ data: { files: [{ id: 'folder_house' }] } }) // House
        .mockResolvedValueOnce({ data: { files: [{ id: 'folder_sunrun' }] } }) // Sunrun Bills
        .mockResolvedValueOnce({ data: { files: [] } }); // check if file exists
      mockDrive.files.create.mockResolvedValue({
        data: { id: 'sunrun_file_123' },
      });

      const result = await service.handleTransaction({
        from: 'billing@sunrun.com',
        subject: 'Your Sunrun Bill is Ready',
        message: {
          data: {
            id: 'msg_sunrun_123',
            payload: {
              headers: [{ name: 'Date', value: 'Wed, 15 Nov 2023 10:00:00 -0500' }],
              parts: [
                {
                  mimeType: 'application/pdf',
                  filename: 'sunrun_bill.pdf',
                  body: { attachmentId: 'att_123' },
                },
              ],
            },
          },
        },
      });

      expect(result).toBe(true);
      expect(mockGmail.users.messages.attachments.get).toHaveBeenCalledWith({
        userId: 'me',
        messageId: 'msg_sunrun_123',
        id: 'att_123',
      });
      expect(mockDrive.files.create).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: expect.objectContaining({
            name: expect.stringMatching(/^Sunrun_Bill_\d{4}-\d{2}-\d{2}\.pdf$/),
          }),
        })
      );
    });

    // Remove skip to run integration test.
    it.skip('INTEGRATION: actually extracts PDF and uploads to Drive', async () => {
      // Ensure .env has valid credentials before running this!
      const realService = new TransactionAutomationService();

      // Search for the most recent Sunrun bill email
      const searchResponse = await realService.gmail.users.messages.list({
        userId: 'me',
        q: 'subject:"your sunrun bill"',
        maxResults: 1,
      });

      if (!searchResponse?.data?.messages?.length) {
        throw new Error('No Sunrun bill emails found in Gmail. Send yourself a test email first.');
      }

      const messageId = searchResponse.data.messages[0].id;
      const msg = await realService.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
      });

      const subject = msg.data.payload.headers.find((h) => h.name === 'Subject')?.value || '';
      const from = msg.data.payload.headers.find((h) => h.name === 'From')?.value || '';

      const result = await realService.handleTransaction({
        from,
        subject,
        message: msg,
      });

      expect(result).toBe(true);
    }, 30000); // Increased timeout for real network requests
  });

  describe('Capital One', () => {
    it('deletes "Pay AT&T" event', async () => {
      // Override the default empty list behavior for this specific test
      mockCalendar.events.list.mockResolvedValue({
        data: {
          items: [{ id: 'evt_1', summary: 'Pay AT&T', start: { date: '2023-01-01' } }],
        },
      });

      const result = await service.handleTransaction({
        from: 'capitalone@capitalone.com',
        subject: 'Withdrawal Notice',
        message: {
          data: {
            payload: {
              mimeType: 'text/plain',
              body: {
                data: Buffer.from('ATT has initiated a withdrawal').toString('base64'),
              },
            },
          },
        },
      });

      expect(result).toBe(true);
      expect(mockCalendar.events.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: 'cal_123',
          eventId: 'evt_1',
        })
      );
    });

    it('deletes "Verizon withdrawal" event', async () => {
      mockCalendar.events.list.mockResolvedValue({
        data: {
          items: [
            {
              id: 'evt_verizon',
              summary: 'Verizon withdrawal',
              start: { date: '2023-10-14' },
            },
          ],
        },
      });

      const result = await service.handleTransaction({
        from: 'capitalone@capitalone.com',
        subject: 'Withdrawal Notice',
        message: {
          data: {
            payload: {
              mimeType: 'text/plain',
              body: {
                data: Buffer.from('Verizon has initiated a withdrawal of $64.99').toString('base64'),
              },
            },
          },
        },
      });

      expect(result).toBe(true);
      expect(mockCalendar.events.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: 'cal_123',
          eventId: 'evt_verizon',
        })
      );
    });

    it('ignores unknown withdrawal', async () => {
      const result = await service.handleTransaction({
        from: 'capitalone@capitalone.com',
        subject: 'Withdrawal Notice',
        message: {
          data: {
            payload: {
              mimeType: 'text/plain',
              body: {
                data: Buffer.from('Unknown Merchant has initiated').toString('base64'),
              },
            },
          },
        },
      });
      expect(result).toBe(false);
      expect(mockCalendar.events.delete).not.toHaveBeenCalled();
    });
  });

  describe('Comcast', () => {
    it('deletes "Comcast / Xfinity Withdrawal" event when detected in body', async () => {
      mockCalendar.events.list.mockResolvedValue({
        data: {
          items: [
            {
              id: 'evt_comcast',
              summary: 'Comcast / Xfinity Withdrawal',
              start: { date: '2023-01-01' },
            },
          ],
        },
      });

      const result = await service.handleTransaction({
        from: 'capitalone@capitalone.com',
        subject: 'Withdrawal Notice',
        message: {
          data: {
            payload: {
              mimeType: 'text/plain',
              body: {
                data: Buffer.from('comcast-xfinity has initiated a withdrawal of $120.00').toString('base64'),
              },
            },
          },
        },
      });

      expect(result).toBe(true);
      expect(mockCalendar.events.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'evt_comcast',
        })
      );
    });

    it('deletes "Comcast / Xfinity Withdrawal" event when detected in subject', async () => {
      mockCalendar.events.list.mockResolvedValue({
        data: {
          items: [
            {
              id: 'evt_comcast',
              summary: 'Comcast / Xfinity Withdrawal',
              start: { date: '2023-01-01' },
            },
          ],
        },
      });

      const result = await service.handleTransaction({
        from: 'no-reply@alert.chase.com',
        subject: 'Your transaction with comcast / xfinity of $120.00',
        message: {},
      });

      expect(result).toBe(true);
      expect(mockCalendar.events.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'evt_comcast',
        })
      );
    });

    it('ignores invalid amounts', async () => {
      const result = await service.handleTransaction({
        from: 'no-reply@alert.chase.com',
        subject: 'Your transaction with comcast / xfinity of $500.00',
        message: {},
      });

      expect(result).toBe(false);
      expect(mockCalendar.events.delete).not.toHaveBeenCalled();
    });
  });

  describe('Chase checking transfer alert', () => {
    it('deletes the current-month "Pay Lowes" event', async () => {
      mockCalendar.events.list.mockResolvedValue({
        data: {
          items: [
            {
              id: 'evt_lowes',
              summary: 'Pay Lowes',
              start: { date: '2023-01-01' },
            },
          ],
        },
      });

      const result = await service.handleTransaction({
        from: 'Chase <no.reply.alerts@chase.com>',
        subject: 'You sent $500.00 from account ending in (...8354)',
        message: {
          data: {
            payload: {
              mimeType: 'text/html',
              body: {
                data: Buffer.from('<p>You sent $500.00 to <strong>LOWES</strong></p>').toString('base64'),
              },
            },
          },
        },
      });

      expect(result).toBe(true);
      expect(mockCalendar.events.delete).toHaveBeenCalledWith({
        calendarId: 'cal_123',
        eventId: 'evt_lowes',
      });
    });

    it('ignores an unknown transfer recipient', async () => {
      const result = await service.handleTransaction({
        from: 'Chase <no.reply.alerts@chase.com>',
        subject: 'You sent $100.00 from account ending in (...8354)',
        message: {
          data: {
            payload: {
              mimeType: 'text/plain',
              body: {
                data: Buffer.from('You sent $100.00 to SOMEONE').toString('base64'),
              },
            },
          },
        },
      });

      expect(result).toBe(false);
      expect(mockCalendar.events.delete).not.toHaveBeenCalled();
    });
  });

  describe('Amex', () => {
    it('deletes "Pay Amex" event for next month', async () => {
      mockCalendar.events.list.mockImplementation(() =>
        Promise.resolve({
          data: {
            items: [
              {
                id: 'evt_amex',
                summary: 'Pay Amex',
                start: { date: '2023-02-01' },
              },
            ],
          },
        })
      );

      const result = await service.handleTransaction({
        from: 'AmericanExpress@welcome.americanexpress.com',
        subject: 'We received your payment',
        message: {},
      });

      expect(result).toBe(true);
      expect(mockCalendar.events.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'evt_amex',
        })
      );
    });
  });

  describe('Chase', () => {
    it('deletes "Pay Chase" event for next month', async () => {
      mockCalendar.events.list.mockResolvedValue({
        data: {
          items: [
            {
              id: 'evt_chase',
              summary: 'Pay Chase',
              start: { date: '2023-02-01' },
            },
          ],
        },
      });

      const result = await service.handleTransaction({
        from: 'no-reply@chase.com',
        subject: 'Your credit card payment is scheduled',
        message: {},
      });

      expect(result).toBe(true);
      expect(mockCalendar.events.delete).toHaveBeenCalled();
    });

    it('deletes "Pay mortgage" event for next month', async () => {
      mockCalendar.events.list.mockResolvedValue({
        data: {
          items: [
            {
              id: 'evt_mortgage',
              summary: 'Pay mortgage',
              start: { date: '2023-02-01' },
            },
          ],
        },
      });

      const result = await service.handleTransaction({
        from: 'no-reply@chase.com',
        subject: 'You scheduled your mortgage payment',
        message: {},
      });

      expect(result).toBe(true);
      expect(mockCalendar.events.delete).toHaveBeenCalled();
    });
  });

  describe('Eversource', () => {
    it('patches "Pay Gas Bill" event with amount', async () => {
      mockCalendar.events.list.mockResolvedValue({
        data: {
          items: [
            {
              id: 'evt_gas',
              summary: 'Pay Gas Bill',
              start: { date: '2023-01-15' },
            },
          ],
        },
      });

      const result = await service.handleTransaction({
        from: 'no-reply@chase.com',
        subject: 'Your transaction with spi*eversource for $123.45',
        message: {},
      });

      expect(result).toBe(true);
      expect(mockCalendar.events.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'evt_gas',
          requestBody: { summary: 'Gas Bill - $123.45' },
        })
      );
    });

    it('ignores Eversource if no amount found', async () => {
      const result = await service.handleTransaction({
        from: 'no-reply@chase.com',
        subject: 'Your transaction with spi*eversource',
        message: {},
      });

      expect(result).toBe(false);
    });
  });

  describe('General Handling', () => {
    it('ignores unrelated emails', async () => {
      const result = await service.handleTransaction({
        from: 'spam@spam.com',
        subject: 'Enlarge your code coverage',
        message: {},
      });

      expect(result).toBe(false);
    });

    it('ignores emails with spoofed display names', async () => {
      const result = await service.handleTransaction({
        from: '"Chase Alerts (chase.com)" <attacker@evil.com>',
        subject: 'You scheduled your mortgage payment',
        message: {},
      });

      expect(result).toBe(false);
    });

    it('ignores emails from lookalike or attacker domains', async () => {
      const result = await service.handleTransaction({
        from: 'alerts@fakechase.com',
        subject: 'You scheduled your mortgage payment',
        message: {},
      });

      expect(result).toBe(false);
    });

    it('marks message as read', async () => {
      await service.markMessageAsRead({
        from: 'test@test.com',
        subject: 'test',
        messageId: 'msg_123',
      });

      expect(mockGmail.users.messages.modify).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'msg_123',
          requestBody: { removeLabelIds: ['UNREAD'] },
        })
      );
    });
  });

  describe('Modular Transaction Rules Engine', () => {
    it('exports transactionRules with valid structure', () => {
      expect(Array.isArray(transactionRules)).toBe(true);
      expect(transactionRules.length).toBeGreaterThan(0);

      for (const rule of transactionRules) {
        expect(typeof rule.name).toBe('string');
        expect(typeof rule.matches).toBe('function');
        expect(typeof rule.execute).toBe('function');
      }
    });

    it('defaults service.rules to transactionRules when not supplied', () => {
      const defaultService = new TransactionAutomationService(
        {
          firestore: mockFirestore,
          gmail: mockGmail,
          calendar: mockCalendar,
          drive: mockDrive,
        },
        { CALENDAR_NAME: 'Test Calendar' }
      );
      expect(defaultService.rules).toBe(transactionRules);
    });

    it('executes custom injected rules via services.rules', async () => {
      const customRule = {
        name: 'Custom Test Rule',
        matches: jest.fn(({ subj }) => subj.includes('custom test')),
        execute: jest.fn().mockResolvedValue(true),
      };

      const customService = new TransactionAutomationService(
        {
          firestore: mockFirestore,
          gmail: mockGmail,
          calendar: mockCalendar,
          drive: mockDrive,
          rules: [customRule],
        },
        { CALENDAR_NAME: 'Test Calendar' }
      );

      const result = await customService.handleTransaction({
        from: 'test@custom.com',
        subject: 'This is a custom test bill',
        message: {},
      });

      expect(result).toBe(true);
      expect(customRule.matches).toHaveBeenCalled();
      expect(customRule.execute).toHaveBeenCalled();
    });

    it('falls through and returns false when injected rules do not match', async () => {
      const customRule = {
        name: 'Non Matching Rule',
        matches: jest.fn().mockReturnValue(false),
        execute: jest.fn().mockResolvedValue(true),
      };

      const customService = new TransactionAutomationService(
        {
          firestore: mockFirestore,
          gmail: mockGmail,
          calendar: mockCalendar,
          drive: mockDrive,
          rules: [customRule],
        },
        { CALENDAR_NAME: 'Test Calendar' }
      );

      const result = await customService.handleTransaction({
        from: 'test@custom.com',
        subject: 'Unmatched subject',
        message: {},
      });

      expect(result).toBe(false);
      expect(customRule.matches).toHaveBeenCalled();
      expect(customRule.execute).not.toHaveBeenCalled();
    });
  });

  describe('handleEvent (Pub/Sub entry point)', () => {
    it('skips if no message data', async () => {
      await service.handleEvent({ data: {} });
      expect(mockFirestore.collection).not.toHaveBeenCalled();
    });

    it('processes new history successfully', async () => {
      const event = {
        data: {
          message: {
            data: Buffer.from(
              JSON.stringify({
                emailAddress: 'me@example.com',
                historyId: 1000,
              })
            ).toString('base64'),
          },
        },
      };

      // Setup Firestore mocks
      // 1. lastHistoryId check (handleEvent line 109)
      mockFirestore.get.mockResolvedValueOnce({
        exists: true,
        data: () => ({ lastHistoryId: 900 }),
      });
      // 2. atomic lock check (processHistoryPage now uses create())
      mockFirestore.create.mockResolvedValueOnce();

      // Gmail history mock
      mockGmail.users.history.list.mockResolvedValue({
        data: {
          history: [
            {
              messagesAdded: [{ message: { id: 'new_msg_1' } }],
            },
          ],
        },
      });

      mockGmail.users.messages.get.mockResolvedValue({
        data: {
          payload: {
            headers: [
              { name: 'Subject', value: 'Test Subject' },
              { name: 'From', value: 'test@test.com' },
            ],
          },
        },
      });

      await service.handleEvent(event);

      expect(mockGmail.users.history.list).toHaveBeenCalled();
      expect(mockFirestore.create).toHaveBeenCalled();
      expect(mockFirestore.set).toHaveBeenCalledWith(
        expect.objectContaining({ lastHistoryId: 1000 }),
        expect.objectContaining({ merge: true })
      );
    });

    it('resets baseline on Gmail API 400 error', async () => {
      const event = {
        data: {
          message: {
            data: Buffer.from(
              JSON.stringify({
                emailAddress: 'me@example.com',
                historyId: 1000,
              })
            ).toString('base64'),
          },
        },
      };

      // lastHistoryId check
      mockFirestore.get.mockResolvedValueOnce({
        exists: true,
        data: () => ({ lastHistoryId: 900 }),
      });

      // Gmail history list fails with 400 (expired historyId)
      const error = new Error('Invalid historyId');
      error.response = { status: 400 };
      mockGmail.users.history.list.mockRejectedValue(error);

      // getProfile and baseline reset
      mockGmail.users.getProfile.mockResolvedValue({
        data: { historyId: 2000 },
      });

      await service.handleEvent(event);

      expect(mockGmail.users.getProfile).toHaveBeenCalled();
      expect(mockFirestore.set).toHaveBeenCalledWith(
        expect.objectContaining({ lastHistoryId: 2000 }),
        expect.objectContaining({ merge: true })
      );
    });

    it('handles numeric string historyId comparisons correctly using BigInt', async () => {
      const event = {
        data: {
          message: {
            data: Buffer.from(
              JSON.stringify({
                emailAddress: 'me@example.com',
                historyId: '1000',
              })
            ).toString('base64'),
          },
        },
      };

      // In lexicographical comparison, '1000' < '900'. But as BigInt, 1000 > 900.
      mockFirestore.get.mockResolvedValueOnce({
        exists: true,
        data: () => ({ lastHistoryId: '900' }),
      });
      mockFirestore.create.mockResolvedValueOnce();

      mockGmail.users.history.list.mockResolvedValue({
        data: {
          history: [],
        },
      });

      await service.handleEvent(event);

      // Verify it was NOT skipped as old/duplicate
      expect(mockGmail.users.history.list).toHaveBeenCalled();
      expect(mockFirestore.set).toHaveBeenCalledWith(
        expect.objectContaining({ lastHistoryId: '1000' }),
        expect.objectContaining({ merge: true })
      );
    });

    it('rethrows non-400 Gmail API errors so Pub/Sub can retry', async () => {
      const event = {
        data: {
          message: {
            data: Buffer.from(
              JSON.stringify({
                emailAddress: 'me@example.com',
                historyId: 1000,
              })
            ).toString('base64'),
          },
        },
      };

      mockFirestore.get.mockResolvedValueOnce({
        exists: true,
        data: () => ({ lastHistoryId: 900 }),
      });

      const serverError = new Error('Internal Server Error');
      serverError.response = { status: 500 };
      mockGmail.users.history.list.mockRejectedValue(serverError);

      await expect(service.handleEvent(event)).rejects.toThrow('Internal Server Error');
    });

    it('does not advance lastHistoryId and throws if message processing fails', async () => {
      const event = {
        data: {
          message: {
            data: Buffer.from(
              JSON.stringify({
                emailAddress: 'me@example.com',
                historyId: 1000,
              })
            ).toString('base64'),
          },
        },
      };

      mockFirestore.get.mockResolvedValueOnce({
        exists: true,
        data: () => ({ lastHistoryId: 900 }),
      });
      mockGmail.users.history.list.mockResolvedValue({
        data: {
          history: [{ messagesAdded: [{ message: { id: 'fail_msg_1' } }] }],
        },
      });
      mockFirestore.create.mockResolvedValueOnce();
      mockGmail.users.messages.get.mockRejectedValue(new Error('Drive upload network failure'));

      await expect(service.handleEvent(event)).rejects.toThrow('Drive upload network failure');
      expect(mockFirestore.set).not.toHaveBeenCalledWith(
        expect.objectContaining({ lastHistoryId: 1000 }),
        expect.anything()
      );
    });
  });

  describe('Drive file management', () => {
    it('updates existing file in Drive', async () => {
      const fileData = {
        buffer: Buffer.from('new-data'),
        fileName: 'test.pdf',
      };
      const folderPath = 'House/Bills';

      // 1. House folder check
      mockDrive.files.list
        .mockResolvedValueOnce({ data: { files: [{ id: 'f1' }] } })
        // 2. Bills folder check
        .mockResolvedValueOnce({ data: { files: [{ id: 'f2' }] } })
        // 3. File existence check (found)
        .mockResolvedValueOnce({ data: { files: [{ id: 'file_789' }] } });

      await service.uploadToDrive(fileData, folderPath);

      expect(mockDrive.files.update).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'file_789' }));
      expect(mockDrive.files.create).not.toHaveBeenCalled();
    });
  });

  describe('Email extraction', () => {
    it('skips missing message with 404', async () => {
      // Mock history found one message
      mockGmail.users.history.list.mockResolvedValue({
        data: {
          history: [{ messagesAdded: [{ message: { id: 'missing_1' } }] }],
        },
      });
      // Mock deduplication check (using atomic create now)
      mockFirestore.create.mockResolvedValueOnce();
      // Mock get message details fails with 404
      const error = new Error('Not Found');
      error.code = 404;
      mockGmail.users.messages.get.mockRejectedValue(error);

      // processHistoryPage should skip it and not crash
      const results = await service.processHistoryPage('900');
      expect(results.processedCount).toBe(0);
    });

    it('removes deduplication document and throws if message processing fails', async () => {
      mockGmail.users.history.list.mockResolvedValue({
        data: {
          history: [{ messagesAdded: [{ message: { id: 'fail_msg_1' } }] }],
        },
      });
      mockFirestore.create.mockResolvedValueOnce();
      mockGmail.users.messages.get.mockRejectedValue(new Error('Network error'));

      await expect(service.processHistoryPage('900')).rejects.toThrow('Network error');
      expect(mockFirestore.collection).toHaveBeenCalledWith('processed_messages');
      expect(mockFirestore.doc).toHaveBeenCalledWith('fail_msg_1');
      expect(mockFirestore.delete).toHaveBeenCalled();
    });

    it('extracts body from multipart email', async () => {
      const message = {
        data: {
          payload: {
            mimeType: 'multipart/alternative',
            parts: [
              {
                mimeType: 'text/html',
                body: {
                  data: Buffer.from('<html>Body</html>').toString('base64'),
                },
              },
            ],
          },
        },
      };

      const result = await service.handleTransaction({
        from: 'capitalone@capitalone.com',
        subject: 'Withdrawal Notice',
        message: message,
      });
      // Should be false because 'att has initiated' etc is not in the html body
      expect(result).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('handles Drive upload failure', async () => {
      mockDrive.files.list.mockRejectedValue(new Error('Drive error'));

      await expect(service.uploadToDrive({ buffer: Buffer.from(''), fileName: 't.pdf' }, 'H/B')).rejects.toThrow(
        'Drive error'
      );
    });

    it('handles Calendar API error gracefully', async () => {
      mockCalendar.calendarList.list.mockRejectedValue(new Error('Cal error'));

      const result = await service.processCalendarEvents('Test', {
        action: 'delete',
      });
      expect(result).toBe(false);
    });

    it('handles missing calendar', async () => {
      mockCalendar.calendarList.list.mockResolvedValue({ data: { items: [] } });
      const result = await service.processCalendarEvents('Test', {
        action: 'delete',
      });
      expect(result).toBe(false);
    });

    it('handles no events found', async () => {
      mockCalendar.events.list.mockResolvedValue({ data: { items: [] } });
      const result = await service.processCalendarEvents('Test', {
        action: 'delete',
      });
      expect(result).toBe(false);
    });

    it('handles unknown action', async () => {
      mockCalendar.events.list.mockResolvedValue({
        data: {
          items: [{ id: 'e1', summary: 'Test', start: { date: '2023-01-01' } }],
        },
      });
      const result = await service.processCalendarEvents('Test', {
        action: 'unknown',
      });
      expect(result).toBe(true);
    });

    it('handles folder creation failure', async () => {
      // First folder 'House' not found
      mockDrive.files.list.mockResolvedValueOnce({ data: { files: [] } });
      // Create folder 'House' fails
      mockDrive.files.create.mockRejectedValue(new Error('Folder create error'));

      await expect(service.uploadToDrive({ buffer: Buffer.from(''), fileName: 't.pdf' }, 'House/B')).rejects.toThrow(
        'Folder create error'
      );
    });
  });

  describe('isFromDomain', () => {
    it('matches exact domain', () => {
      expect(isFromDomain('user@chase.com', 'chase.com')).toBe(true);
    });

    it('matches subdomains', () => {
      expect(isFromDomain('alerts@mail.chase.com', 'chase.com')).toBe(true);
      expect(isFromDomain('alerts@a.b.chase.com', 'chase.com')).toBe(true);
    });

    it('matches addresses with display names', () => {
      expect(isFromDomain('Chase <no-reply@chase.com>', 'chase.com')).toBe(true);
      expect(isFromDomain('"Chase Alerts" <alerts@mail.chase.com>', 'chase.com')).toBe(true);
      expect(isFromDomain('<customerservice@nationalgridus.com>', 'nationalgridus.com')).toBe(true);
    });

    it('handles case insensitivity', () => {
      expect(isFromDomain('AmericanExpress@welcome.americanexpress.com', 'americanexpress.com')).toBe(true);
      expect(isFromDomain('USER@CHASE.COM', 'chase.com')).toBe(true);
      expect(isFromDomain('user@chase.com', 'CHASE.COM')).toBe(true);
    });

    it('rejects lookalike domains and attacker prefixes/suffixes', () => {
      expect(isFromDomain('attacker@fakechase.com', 'chase.com')).toBe(false);
      expect(isFromDomain('attacker@not-chase.com', 'chase.com')).toBe(false);
      expect(isFromDomain('attacker@chase.com.attacker.com', 'chase.com')).toBe(false);
      expect(isFromDomain('attacker@chase.community', 'chase.com')).toBe(false);
    });

    it('rejects display name injection when address is untrusted', () => {
      expect(isFromDomain('"chase.com support" <attacker@evil.com>', 'chase.com')).toBe(false);
      expect(isFromDomain('Chase <chase.com> <attacker@evil.com>', 'chase.com')).toBe(false);
    });

    it('rejects invalid or malformed inputs', () => {
      expect(isFromDomain('', 'chase.com')).toBe(false);
      expect(isFromDomain(null, 'chase.com')).toBe(false);
      expect(isFromDomain(undefined, 'chase.com')).toBe(false);
      expect(isFromDomain('not-an-email', 'chase.com')).toBe(false);
      expect(isFromDomain('user@chase.com', '')).toBe(false);
      expect(isFromDomain('user@chase.com', null)).toBe(false);
    });
  });
});
