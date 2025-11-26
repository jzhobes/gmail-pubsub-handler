import NationalGridClient from './NationalGridClient.js';
import fs from 'fs';

/**
 * Runs a series of integration style tests for the NationalGridClient.
 * The tests are lightweight and rely on real credentials in the environment.
 * They exercise the main public methods of the client and also cover error handling.
 */
async function runTests() {
    console.log('🧪 Starting NationalGridClient test suite...');

    // Helper to clean up any downloaded bill file after tests
    const cleanup = (filePath) => {
        try { fs.unlinkSync(filePath); } catch (_) {}
    };

    // ---------------------------------------------------------------------
    // Test 1: login() succeeds (implicit in other calls, but we call explicitly)
    // ---------------------------------------------------------------------
    try {
        console.log('\n--- Test: login() ---');
        const client = new NationalGridClient();
        await client.login();
        console.log('✅ login() succeeded');
    } catch (err) {
        console.error('❌ login() failed:', err);
        process.exit(1);
    }

    // ---------------------------------------------------------------------
    // Test 2: getBillHistory() returns an array of bills
    // ---------------------------------------------------------------------
    try {
        console.log('\n--- Test: getBillHistory() ---');
        const client = new NationalGridClient();
        const history = await client.getBillHistory();
        if (!Array.isArray(history)) throw new Error('Bill history is not an array');
        console.log(`✅ getBillHistory() returned ${history.length} entries`);
    } catch (err) {
        console.error('❌ getBillHistory() failed:', err);
        process.exit(1);
    }

    // Test getCurrentBill() without saving to disk
    try {
        console.log('\n--- Test: getCurrentBill() ---');
        const bill = await client.getCurrentBill();
        if (!bill || !bill.buffer || !bill.fileName) {
            throw new Error('Invalid bill object');
        }
        console.log(`✅ getCurrentBill() returned file ${bill.fileName} (${bill.buffer.length} bytes)`);
    } catch (err) {
        console.error('❌ getCurrentBill() failed:', err);
        process.exit(1);
    }

    // Test downloadCurrentBill() which also saves the file
    try {
        console.log('\n--- Test: downloadCurrentBill() ---');
        const filePath = await client.downloadCurrentBill();
        console.log(`✅ downloadCurrentBill() saved to ${filePath}`);
    } catch (err) {
        console.error('❌ downloadCurrentBill() failed:', err);
        process.exit(1);
    }

    console.log('\n🎉 All NationalGridClient tests passed!');
}

runTests();
