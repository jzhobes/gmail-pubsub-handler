/**
 * OAuth Refresh Token Generator
 *
 * Usage:
 * 1. Ensure .env contains GMAIL_OAUTH_CREDENTIALS={"client_id":"...","client_secret":"..."}
 * 2. Run: node refreshToken.js
 * 3. Visit the displayed URL and authorize the app
 * 4. Copy the authorization code from the URL after redirect
 * 5. Paste the code when prompted
 * 6. Copy the refresh_token output
 * 7. Update Secret Manager with JSON: {"client_id":"...", "client_secret":"...", "refresh_token":"..."}
 */

import 'dotenv/config';
import { google } from 'googleapis';
import readline from 'readline';

const { GMAIL_OAUTH_CREDENTIALS } = process.env;
if (!GMAIL_OAUTH_CREDENTIALS) {
    console.error('Error: GMAIL_OAUTH_CREDENTIALS missing from .env');
    process.exit(1);
}

const { client_id, client_secret } = JSON.parse(GMAIL_OAUTH_CREDENTIALS);

const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    'http://localhost'
);

const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/drive'
    ],
});
console.log('Authorize this app by visiting:', url);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Enter the code here: ', async code => {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('Your refresh token:', tokens.refresh_token);
    rl.close();
});
