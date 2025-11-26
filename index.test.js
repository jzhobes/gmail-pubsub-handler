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

            const result = await realService.handleTransaction({
                from: 'customerservice@nationalgridus.com',
                subject: 'Your National Grid bill is ready',
                message: {}
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

// describe('Integration: Google Drive Upload', () => {
//     // Only run if NOT mocked (controlled via flag or just run manually)
//     // For now, we assume the user wants to test this specifically.
    
//     it('actually uploads a test file to Drive', async () => {
//         // We use the REAL uploadToDrive here, not the spy.
//         // Ensure we have a valid buffer.
//         const fakeFile = {
//             buffer: Buffer.from('This is a test file from Jest integration test.'),
//             fileName: `Jest_Test_Upload_${Date.now()}.txt`
//         };

//         try {
//             await index.uploadToDrive(fakeFile, 'House/Test Uploads');
//             // If it doesn't throw, it succeeded.
//         } catch (err) {
//             // If it fails (e.g. auth error), fail the test
//             throw err;
//         }
//     });
// });
