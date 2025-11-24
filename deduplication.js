/**
 * Checks if a message has already been processed and marks it as processed if not.
 * Uses a Firestore document with a TTL to track processed message IDs.
 *
 * @param {Firestore} firestore - The Firestore instance.
 * @param {string} messageId - The unique ID of the Gmail message.
 * @returns {Promise<boolean>} - Returns `true` if the message is new and successfully marked as processed, `false` if it was already processed.
 */
export async function checkAndMarkMessageProcessed(firestore, messageId) {
    const docRef = firestore.collection('processed_messages').doc(messageId);
    try {
        // Try to create the document. Fails if it already exists.
        await docRef.create({
            timestamp: Date.now(),
            // 7 days matches the max retention of Google Cloud Pub/Sub messages.
            // This ensures we never re-process a message even after a week-long outage.
            ttl: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days TTL
        });
        return true;
    } catch (err) {
        if (err.code === 6) { // ALREADY_EXISTS
            return false;
        }
        throw err;
    }
}
