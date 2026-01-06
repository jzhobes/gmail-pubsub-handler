import { jest } from '@jest/globals';

// Mock pdf-parse class
const mockGetText = jest.fn();
const mockDestroy = jest.fn();

jest.unstable_mockModule('pdf-parse', () => ({
  PDFParse: jest.fn(() => ({
    getText: mockGetText,
    destroy: mockDestroy,
  })),
}));

// Dynamic import after mocking
const { default: SunrunClient } = await import('./SunrunClient.js');

describe('SunrunClient', () => {
  let client;
  let mockGmail;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new SunrunClient();
    mockGmail = {
      users: {
        messages: {
          attachments: {
            get: jest.fn(),
          },
        },
      },
    };
  });

  describe('extractBillDetailsFromPdf', () => {
    it('extracts date correctly from valid PDF text', async () => {
      mockGetText.mockResolvedValue({
        text: 'Some text... Billing Period: 10/01 - 10/31 ... Due Date: 11/16/2023 ...',
      });

      const date = await client.extractBillDetailsFromPdf(Buffer.from('pdf'));
      expect(date).toBe('2023-10-31');
      expect(mockDestroy).toHaveBeenCalled();
    });

    it('extracts date correctly with month names', async () => {
      mockGetText.mockResolvedValue({
        text: 'Billing Period: Oct 15 - Nov 14 ... Due Date: 12/14/2025',
      });

      const date = await client.extractBillDetailsFromPdf(Buffer.from('pdf'));
      expect(date).toBe('2025-11-14');
    });

    it('handles year rollover (Dec bill due in Jan)', async () => {
      mockGetText.mockResolvedValue({
        text: 'Billing Period: 12/01 - 12/31 ... Due Date: 01/15/2024',
      });

      const date = await client.extractBillDetailsFromPdf(Buffer.from('pdf'));
      expect(date).toBe('2023-12-31'); // Should be previous year of due date
    });

    it('returns null if patterns not found', async () => {
      mockGetText.mockResolvedValue({ text: 'No dates here' });
      const date = await client.extractBillDetailsFromPdf(Buffer.from('pdf'));
      expect(date).toBeNull();
    });

    it('returns null on parser error', async () => {
      mockGetText.mockRejectedValue(new Error('Parse error'));
      const date = await client.extractBillDetailsFromPdf(Buffer.from('pdf'));
      expect(date).toBeNull();
      expect(mockDestroy).toHaveBeenCalled();
    });
  });

  describe('getBillFromMessage', () => {
    const mockMessage = {
      data: {
        id: 'msg_123',
        payload: {
          headers: [{ name: 'Date', value: '2023-11-15T10:00:00Z' }],
          parts: [
            {
              mimeType: 'application/pdf',
              filename: 'bill.pdf',
              body: { attachmentId: 'att_123' },
            },
          ],
        },
      },
    };

    it('returns bill data with extracted date when PDF parsing succeeds', async () => {
      // Mock attachment download
      mockGmail.users.messages.attachments.get.mockResolvedValue({
        data: { data: Buffer.from('pdf-content').toString('base64') },
      });

      // Mock PDF parsing success
      mockGetText.mockResolvedValue({
        text: 'Billing Period: 10/01 - 10/31 ... Due Date: 11/16/2023',
      });

      const result = await client.getBillFromMessage(mockMessage, mockGmail);

      expect(result).toEqual({
        buffer: expect.any(Buffer),
        fileName: 'Sunrun_Bill_2023-10-31.pdf',
      });
    });

    it('falls back to email date when PDF parsing fails', async () => {
      // Mock attachment download
      mockGmail.users.messages.attachments.get.mockResolvedValue({
        data: { data: Buffer.from('pdf-content').toString('base64') },
      });

      // Mock PDF parsing failure (no text match)
      mockGetText.mockResolvedValue({ text: 'Garbage text' });

      const result = await client.getBillFromMessage(mockMessage, mockGmail);

      // Should use email date (2023-11-15)
      expect(result).toEqual({
        buffer: expect.any(Buffer),
        fileName: 'Sunrun_Bill_2023-11-15.pdf',
      });
    });

    it('returns null if no PDF attachment found', async () => {
      const noPdfMessage = {
        data: { payload: { parts: [] } },
      };
      const result = await client.getBillFromMessage(noPdfMessage, mockGmail);
      expect(result).toBeNull();
    });
  });
});
