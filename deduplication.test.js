import { checkAndMarkMessageProcessed } from './deduplication.js';
import { jest } from '@jest/globals';

describe('Deduplication Logic', () => {
  let mockFirestore;
  let mockCollection;
  let mockDoc;

  beforeEach(() => {
    mockDoc = {
      create: jest.fn(),
    };
    mockCollection = {
      doc: jest.fn().mockReturnValue(mockDoc),
    };
    mockFirestore = {
      collection: jest.fn((name) => {
        if (name === 'processed_messages') {
          return mockCollection;
        }
        throw new Error(`Unexpected collection: ${name}`);
      }),
    };
  });

  describe('checkAndMarkMessageProcessed()', () => {
    it('returns true for new message (success)', async () => {
      mockDoc.create.mockResolvedValue({ writeTime: Date.now() });

      const result = await checkAndMarkMessageProcessed(
        mockFirestore,
        'msg_123'
      );

      expect(result).toBe(true);
      expect(mockFirestore.collection).toHaveBeenCalledWith(
        'processed_messages'
      );
      expect(mockCollection.doc).toHaveBeenCalledWith('msg_123');
      expect(mockDoc.create).toHaveBeenCalled();
    });

    it('returns false for duplicate message (already exists)', async () => {
      const e = new Error('Document already exists');
      e.code = 6; // ALREADY_EXISTS code
      mockDoc.create.mockRejectedValue(e);

      const result = await checkAndMarkMessageProcessed(
        mockFirestore,
        'msg_123'
      );

      expect(result).toBe(false);
    });

    it('throws error for other failures', async () => {
      const e = new Error('Connection failed');
      mockDoc.create.mockRejectedValue(e);

      await expect(
        checkAndMarkMessageProcessed(mockFirestore, 'msg_123')
      ).rejects.toThrow('Connection failed');
    });
  });
});
