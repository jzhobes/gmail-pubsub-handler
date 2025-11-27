import { jest } from '@jest/globals';
import { TransactionAutomationService } from './index.js';

// Mock Google APIs (Calendar, Drive, Gmail)
const mockCalendar = {
    calendarList: { list: jest.fn() },
    events: { list: jest.fn(), delete: jest.fn(), patch: jest.fn() }
};
const mockDrive = {
    files: {
        list: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ data: { id: 'updated_file_id' } })
    }
};
const mockGmail = {
    users: {
        messages: { modify: jest.fn() }
    }
};

describe('Transaction Handler Logic', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();

        // Instantiate service with mocks
        service = new TransactionAutomationService({
            calendar: mockCalendar,
            drive: mockDrive,
            gmail: mockGmail,
            // firestore: mockFirestore // Add if needed
        }, {
            CALENDAR_NAME: 'Test Calendar',
            GMAIL_OAUTH_CREDENTIALS: '{}',
            FIRESTORE_COLLECTION: 'gmail-history'
        });

        // Default Calendar Mock Behavior
        mockCalendar.calendarList.list.mockResolvedValue({
            data: { items: [{ summary: 'Test Calendar', id: 'cal_123' }] }
        });
        mockCalendar.events.list.mockResolvedValue({ data: { items: [] } });
    });

    describe('National Grid', () => {
        it('downloads bill and uploads to Drive', async () => {
            // Mock NationalGridClient
            const mockGetCurrentBill = jest.fn().mockResolvedValue({
                buffer: Buffer.from('fake-pdf'),
                fileName: 'bill.pdf'
            });

            // Re-instantiate with NationalGridClient mock
            service = new TransactionAutomationService({
                calendar: mockCalendar,
                drive: mockDrive,
                gmail: mockGmail,
                nationalGrid: { getCurrentBill: mockGetCurrentBill }
            }, {
                CALENDAR_NAME: 'Test Calendar',
                GMAIL_OAUTH_CREDENTIALS: '{}',
                FIRESTORE_COLLECTION: 'gmail-history'
            });

            // Mock Drive behavior
            mockDrive.files.list
                .mockResolvedValueOnce({ data: { files: [{ id: 'folder_root' }] } }) // House
                .mockResolvedValueOnce({ data: { files: [{ id: 'folder_ng' }] } })   // National Grid Bills
                .mockResolvedValueOnce({ data: { files: [] } });                     // check if file exists
            mockDrive.files.create.mockResolvedValue({ data: { id: 'file_456' } });

            const result = await service.handleTransaction({
                from: 'customerservice@nationalgridus.com',
                subject: 'Your National Grid bill is ready',
                message: {}
            });

            expect(result).toBe(true);
            expect(mockGetCurrentBill).toHaveBeenCalled();
            expect(mockDrive.files.create).toHaveBeenCalledWith(expect.objectContaining({
                resource: expect.objectContaining({ name: 'bill.pdf' })
            }));
        });

        // Remove skip to run integration test.
        it.skip('INTEGRATION: actually downloads bill and uploads to Drive', async () => {
            // Ensure .env has valid credentials before running this!
            const realService = new TransactionAutomationService();

            // Search for the most recent National Grid bill email
            const searchResponse = await realService.gmail.users.messages.list({
                userId: 'me',
                q: 'subject:"national grid bill"',
                maxResults: 1
            });

            if (!searchResponse?.data?.messages?.length) {
                throw new Error('No National Grid bill emails found in Gmail. Send yourself a test email first.');
            }

            const messageId = searchResponse.data.messages[0].id;
            const msg = await realService.gmail.users.messages.get({
                userId: 'me',
                id: messageId
            });

            const subject = msg.data.payload.headers.find(h => h.name === 'Subject')?.value || '';
            const from = msg.data.payload.headers.find(h => h.name === 'From')?.value || '';

            const result = await realService.handleTransaction({
                from,
                subject,
                message: msg
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
                            data: mockAttachmentData.toString('base64')
                        }
                    })
                }
            };

            // Mock Drive behavior
            mockDrive.files.list
                .mockResolvedValueOnce({ data: { files: [{ id: 'folder_house' }] } })    // House
                .mockResolvedValueOnce({ data: { files: [{ id: 'folder_sunrun' }] } })   // Sunrun Bills
                .mockResolvedValueOnce({ data: { files: [] } });                         // check if file exists
            mockDrive.files.create.mockResolvedValue({ data: { id: 'sunrun_file_123' } });

            const result = await service.handleTransaction({
                from: 'billing@sunrun.com',
                subject: 'Your Sunrun Bill is Ready',
                message: {
                    data: {
                        id: 'msg_sunrun_123',
                        payload: {
                            headers: [
                                { name: 'Date', value: 'Wed, 15 Nov 2023 10:00:00 -0500' }
                            ],
                            parts: [
                                {
                                    mimeType: 'application/pdf',
                                    filename: 'sunrun_bill.pdf',
                                    body: { attachmentId: 'att_123' }
                                }
                            ]
                        }
                    }
                }
            });

            expect(result).toBe(true);
            expect(mockGmail.users.messages.attachments.get).toHaveBeenCalledWith({
                userId: 'me',
                messageId: 'msg_sunrun_123',
                id: 'att_123'
            });
            expect(mockDrive.files.create).toHaveBeenCalledWith(expect.objectContaining({
                resource: expect.objectContaining({
                    name: expect.stringMatching(/^Sunrun_Bill_\d{4}-\d{2}-\d{2}\.pdf$/)
                })
            }));
        });

        // Remove skip to run integration test.
        it.skip('INTEGRATION: actually extracts PDF and uploads to Drive', async () => {
            // Ensure .env has valid credentials before running this!
            const realService = new TransactionAutomationService();

            // Search for the most recent Sunrun bill email
            const searchResponse = await realService.gmail.users.messages.list({
                userId: 'me',
                q: 'subject:"your sunrun bill"',
                maxResults: 1
            });

            if (!searchResponse?.data?.messages?.length) {
                throw new Error('No Sunrun bill emails found in Gmail. Send yourself a test email first.');
            }

            const messageId = searchResponse.data.messages[0].id;
            const msg = await realService.gmail.users.messages.get({
                userId: 'me',
                id: messageId
            });

            const subject = msg.data.payload.headers.find(h => h.name === 'Subject')?.value || '';
            const from = msg.data.payload.headers.find(h => h.name === 'From')?.value || '';

            const result = await realService.handleTransaction({
                from,
                subject,
                message: msg
            });

            expect(result).toBe(true);
        }, 10000); // Increased timeout for real network requests
    });

    describe('Capital One', () => {
        it('deletes "Pay AT&T" event', async () => {
            // Override the default empty list behavior for this specific test
            mockCalendar.events.list.mockResolvedValue({
                data: { items: [{ id: 'evt_1', summary: 'Pay AT&T', start: { date: '2023-01-01' } }] }
            });

            const result = await service.handleTransaction({
                from: 'capitalone@capitalone.com',
                subject: 'Withdrawal Notice',
                message: {
                    data: {
                        payload: {
                            mimeType: 'text/plain',
                            body: { data: Buffer.from('ATT has initiated a withdrawal').toString('base64') }
                        }
                    }
                }
            });

            expect(result).toBe(true);
            expect(mockCalendar.events.delete).toHaveBeenCalledWith(expect.objectContaining({
                calendarId: 'cal_123',
                eventId: 'evt_1'
            }));
        });

        it('ignores unknown withdrawal', async () => {
            const result = await service.handleTransaction({
                from: 'capitalone@capitalone.com',
                subject: 'Withdrawal Notice',
                message: {
                    data: {
                        payload: {
                            mimeType: 'text/plain',
                            body: { data: Buffer.from('Unknown Merchant has initiated').toString('base64') }
                        }
                    }
                }
            });
            expect(result).toBe(false);
            expect(mockCalendar.events.delete).not.toHaveBeenCalled();
        });
    });

    describe('Amex', () => {
        it('deletes "Pay Amex" event for next month', async () => {
            mockCalendar.events.list.mockImplementation(() => Promise.resolve({
                data: { items: [{ id: 'evt_amex', summary: 'Pay Amex', start: { date: '2023-02-01' } }] }
            }));

            const result = await service.handleTransaction({
                from: 'AmericanExpress@welcome.americanexpress.com',
                subject: 'We received your payment',
                message: {}
            });

            expect(result).toBe(true);
            expect(mockCalendar.events.delete).toHaveBeenCalledWith(expect.objectContaining({
                eventId: 'evt_amex'
            }));
        });
    });
});
