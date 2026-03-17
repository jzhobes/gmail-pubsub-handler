import { jest } from '@jest/globals';
import { TransactionAutomationService } from './index.js';

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
        throw new Error(
          'No National Grid bill emails found in Gmail. Send yourself a test email first.'
        );
      }

      const messageId = searchResponse.data.messages[0].id;
      const msg = await realService.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
      });

      const subject =
        msg.data.payload.headers.find((h) => h.name === 'Subject')?.value || '';
      const from =
        msg.data.payload.headers.find((h) => h.name === 'From')?.value || '';

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
              headers: [
                { name: 'Date', value: 'Wed, 15 Nov 2023 10:00:00 -0500' },
              ],
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
        throw new Error(
          'No Sunrun bill emails found in Gmail. Send yourself a test email first.'
        );
      }

      const messageId = searchResponse.data.messages[0].id;
      const msg = await realService.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
      });

      const subject =
        msg.data.payload.headers.find((h) => h.name === 'Subject')?.value || '';
      const from =
        msg.data.payload.headers.find((h) => h.name === 'From')?.value || '';

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
          items: [
            { id: 'evt_1', summary: 'Pay AT&T', start: { date: '2023-01-01' } },
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
                data: Buffer.from('ATT has initiated a withdrawal').toString(
                  'base64'
                ),
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

    it('ignores unknown withdrawal', async () => {
      const result = await service.handleTransaction({
        from: 'capitalone@capitalone.com',
        subject: 'Withdrawal Notice',
        message: {
          data: {
            payload: {
              mimeType: 'text/plain',
              body: {
                data: Buffer.from('Unknown Merchant has initiated').toString(
                  'base64'
                ),
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
                data: Buffer.from(
                  'comcast-xfinity has initiated a withdrawal of $120.00'
                ).toString('base64'),
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
      // 2. duplicate message check (processHistoryPage line 236)
      mockFirestore.get.mockResolvedValueOnce({
        exists: false,
      });

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

      expect(mockDrive.files.update).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 'file_789' })
      );
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
      // Mock deduplication check
      mockFirestore.get.mockResolvedValueOnce({ exists: false });
      // Mock get message details fails with 404
      const error = new Error('Not Found');
      error.code = 404;
      mockGmail.users.messages.get.mockRejectedValue(error);

      // processHistoryPage should skip it and not crash
      const results = await service.processHistoryPage('900');
      expect(results.processedCount).toBe(0);
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

      await expect(
        service.uploadToDrive(
          { buffer: Buffer.from(''), fileName: 't.pdf' },
          'H/B'
        )
      ).rejects.toThrow('Drive error');
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
      mockDrive.files.create.mockRejectedValue(
        new Error('Folder create error')
      );

      await expect(
        service.uploadToDrive(
          { buffer: Buffer.from(''), fileName: 't.pdf' },
          'House/B'
        )
      ).rejects.toThrow('Folder create error');
    });
  });
});
