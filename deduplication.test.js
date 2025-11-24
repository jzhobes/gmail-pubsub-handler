import { checkAndMarkMessageProcessed } from './deduplication.js';
import assert from 'assert';

async function runTests() {
    console.log('🧪 Running deduplication tests...');

    // Mock Firestore
    const mockDoc = {
        create: async () => { } // Default success
    };
    const mockCollection = {
        doc: (id) => {
            mockDoc.id = id;
            return mockDoc;
        }
    };
    const mockFirestore = {
        collection: (name) => {
            if (name === 'processed_messages') {
                return mockCollection;
            }
            throw new Error(`Unexpected collection: ${name}`);
        }
    };

    // Test 1: Success (New Message)
    try {
        mockDoc.create = async () => { return { writeTime: Date.now() }; };
        const result = await checkAndMarkMessageProcessed(mockFirestore, 'msg_123');
        assert.strictEqual(result, true, 'Should return true for new message');
        console.log('✅ Test 1 Passed: New message processed');
    } catch (err) {
        console.error('❌ Test 1 Failed:', err);
        process.exit(1);
    }

    // Test 2: Duplicate (Already Exists)
    try {
        mockDoc.create = async () => {
            const err = new Error('Document already exists');
            err.code = 6; // ALREADY_EXISTS code
            throw err;
        };
        const result = await checkAndMarkMessageProcessed(mockFirestore, 'msg_123');
        assert.strictEqual(result, false, 'Should return false for duplicate message');
        console.log('✅ Test 2 Passed: Duplicate message skipped');
    } catch (err) {
        console.error('❌ Test 2 Failed:', err);
        process.exit(1);
    }

    // Test 3: Other Error
    try {
        mockDoc.create = async () => {
            throw new Error('Connection failed');
        };
        await checkAndMarkMessageProcessed(mockFirestore, 'msg_123');
        console.error('❌ Test 3 Failed: Should have thrown error');
        process.exit(1);
    } catch (err) {
        if (err.message === 'Connection failed') {
            console.log('✅ Test 3 Passed: Other errors propagated');
        } else {
            console.error('❌ Test 3 Failed: Wrong error thrown', err);
            process.exit(1);
        }
    }

    console.log('🎉 All tests passed!');
}

runTests();
