import fs from 'fs';
import NationalGridClient from './NationalGridClient.js';

describe('NationalGridClient', () => {
    let client;
    const createdFiles = [];

    beforeAll(async () => {
        client = new NationalGridClient();
        await client.login();
    });

    afterAll(() => {
        // Cleanup any files created during tests
        createdFiles.forEach(filePath => {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch (err) {
                console.error(`Failed to cleanup ${filePath}:`, err);
            }
        });
    });

    describe('login()', () => {
        it('succeeds (already logged in)', async () => {
            expect(client.accessToken).toBeDefined();
        });
    });

    describe('getBillHistory()', () => {
        it('returns an array of bills', async () => {
            const history = await client.getBillHistory();
            expect(Array.isArray(history)).toBe(true);
            console.log(`✅ getBillHistory() returned ${history.length} entries`);
        });
    });

    describe('getCurrentBill()', () => {
        it('returns valid bill object', async () => {
            const bill = await client.getCurrentBill();
            expect(bill).toBeDefined();
            expect(bill.buffer).toBeDefined();
            expect(bill.fileName).toBeDefined();
            console.log(`✅ getCurrentBill() returned file ${bill.fileName} (${bill.buffer.length} bytes)`);
        });
    });

    describe('downloadCurrentBill()', () => {
        it('saves file to disk', async () => {
            const filePath = await client.downloadCurrentBill();
            createdFiles.push(filePath);

            expect(typeof filePath).toBe('string');
            expect(fs.existsSync(filePath)).toBe(true);
            console.log(`✅ downloadCurrentBill() saved to ${filePath}`);
        });
    });
});
