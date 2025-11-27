import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Constants
const CLIENT_ID = '36488660-e86a-4a0d-8316-3df49af8d06d';
const MY_ACCOUNT_URL = 'https://myaccount.nationalgrid.com';
const REDIRECT_URI = `${MY_ACCOUNT_URL}/auth-landing`;
const SCOPE = `${CLIENT_ID} openid profile offline_access`;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ORIGIN = 'https://login.nationalgrid.com';

const BASE_URL = 'https://login.nationalgrid.com/login.nationalgridus.com/b2c_1a_nationalgrid_convert_merge_signin';
const AUTHORIZE_URL = `${BASE_URL}/oauth2/v2.0/authorize`;
const TOKEN_URL = `${BASE_URL}/oauth2/v2.0/token`;
const SELF_ASSERTED_URL = `${BASE_URL}/SelfAsserted`;
const CONFIRMED_URL = `${BASE_URL}/api/CombinedSigninAndSignup/confirmed`;
const POLICY = 'B2C_1A_NationalGrid_convert_merge_signin';

// PKCE Helper Functions
function base64URLEncode(str) {
    return str.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest();
}

function generateVerifier() {
    return base64URLEncode(crypto.randomBytes(32));
}

function generateChallenge(verifier) {
    return base64URLEncode(sha256(verifier));
}

/**
 * Helper class for managing cookies during the authentication flow.
 */
class CookieJar {
    constructor() {
        this.cookies = new Map();
    }

    /**
     * Updates the cookie jar with new cookies from response headers.
     *
     * @param {string[]} headers - The 'set-cookie' headers from a fetch response.
     */
    update(headers) {
        if (!headers) {
            return;
        }
        headers.forEach(headerVal => {
            const parts = headerVal.split(';');
            const firstPart = parts[0];
            const eqIdx = firstPart.indexOf('=');
            if (eqIdx > 0) {
                const name = firstPart.substring(0, eqIdx).trim();
                const value = firstPart.substring(eqIdx + 1).trim();
                this.cookies.set(name, value);
            }
        });
    }

    /**
     * Retrieves a cookie value by name.
     *
     * @param {string} name - The name of the cookie.
     * @returns {string|undefined} - The cookie value.
     */
    get(name) {
        return this.cookies.get(name);
    }

    /**
     * Formats all cookies into a string suitable for the 'Cookie' request header.
     *
     * @returns {string} - The formatted cookie string.
     */
    getHeader() {
        return Array.from(this.cookies.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }
}

/**
 * Client for interacting with the National Grid US My Account portal.
 * Handles OAuth 2.0 authentication (B2C), bill history retrieval via GraphQL,
 * and PDF bill downloading.
 */
/**
 * Client for interacting with the National Grid US My Account portal.
 * Handles OAuth 2.0 authentication (B2C), bill history retrieval via GraphQL,
 * and PDF bill downloading.
 */
export default class NationalGridClient {
    constructor() {
        this.cookieJar = new CookieJar();
        this.accessToken = null;
        this.signInName = null;
        this.password = null;
    }

    /**
     * Loads and validates credentials from the environment variable.
     * Supports JSON format or "username:password".
     *
     * @throws {Error} If credentials are missing or invalid.
     */
    loadCredentials() {
        const credentialsRaw = process.env.NATIONAL_GRID_CREDENTIALS;
        if (!credentialsRaw) {
            throw new Error('❌ NATIONAL_GRID_CREDENTIALS not found in .env');
        }

        try {
            const creds = JSON.parse(credentialsRaw);
            this.signInName = creds.signInName;
            this.password = creds.password;
            this.accountNumber = creds.accountNumber;
            this.subscriptionKey = creds.subscriptionKey;
        } catch (error) {
            throw new Error(`❌ Failed to parse NATIONAL_GRID_CREDENTIALS: ${error.message}`);
        }

        if (!this.signInName || !this.password || !this.accountNumber || !this.subscriptionKey) {
            throw new Error('❌ Invalid credentials JSON. Expected "signInName", "password", "accountNumber", and "subscriptionKey".');
        }
    }

    /**
     * Performs the full OAuth 2.0 Authorization Code flow with PKCE.
     * Establishes a session, logs in, and retrieves an access token.
     *
     * @returns {Promise<void>}
     */
    async login() {
        this.loadCredentials();
        console.log('🚀 Starting National Grid login process...');

        // Generate PKCE and State
        const codeVerifier = generateVerifier();
        const codeChallenge = generateChallenge(codeVerifier);
        const clientRequestId = crypto.randomUUID();
        const state = base64URLEncode(crypto.randomBytes(32));

        console.log(`🔑 Generated PKCE Verifier: ${codeVerifier}`);

        // 1. Initial GET request to establish session
        const initialParams = new URLSearchParams({
            client_id: CLIENT_ID,
            scope: SCOPE,
            redirect_uri: REDIRECT_URI,
            'client-request-id': clientRequestId,
            response_mode: 'fragment',
            response_type: 'code',
            'x-client-SKU': 'msal.js.browser',
            'x-client-VER': '3.6.0',
            client_info: '1',
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            state: state,
            region: 'nyupstate',
            customer_type: 'home'
        });

        const initialUrl = `${AUTHORIZE_URL}?${initialParams.toString()}`;

        const getResponse = await fetch(initialUrl, {
            redirect: 'follow',
        });

        if (!getResponse.ok) {
            throw new Error(`❌ Initial GET failed: ${getResponse.status} ${getResponse.statusText}`);
        }

        // Extract Cookies
        this.cookieJar.update(getResponse.headers.getSetCookie());
        if (!this.cookieJar.cookies?.size) {
            throw new Error('❌ No cookies received from initial request');
        }

        // Extract CSRF Token
        const csrfToken = this.cookieJar.get('x-ms-cpim-csrf');
        if (!csrfToken) {
            throw new Error("❌ Could not find x-ms-cpim-csrf cookie for CSRF token.");
        }

        // Extract Transaction ID (TID)
        let transCookie = this.cookieJar.get('x-ms-cpim-trans');
        if (!transCookie) {
            throw new Error('❌ x-ms-cpim-trans cookie not found');
        }

        const decodedTrans = Buffer.from(transCookie, 'base64').toString('utf-8');
        const transJson = JSON.parse(decodedTrans);
        const tid = transJson.C_ID;

        if (!tid) {
            throw new Error('❌ Could not extract TID from x-ms-cpim-trans cookie');
        }

        console.log(`🍪 Extracted TID: ${tid}`);

        // Construct tx parameter
        const txData = { TID: tid };
        const txJson = JSON.stringify(txData).replace(/\s/g, '');
        let txParam = Buffer.from(txJson).toString('base64');

        // 2. Perform Login POST
        const loginUrl = `${SELF_ASSERTED_URL}?tx=StateProperties=${txParam}&p=${POLICY}`;

        const params = new URLSearchParams();
        params.append('signInName', this.signInName);
        params.append('password', this.password);
        params.append('Signin-forgotPassword', 'FORGOT_PASSWORD_FALSE');
        params.append('rememberUserName', 'true');
        params.append('request_type', 'RESPONSE');

        const postResponse = await fetch(loginUrl, {
            method: 'POST',
            headers: {
                'Cookie': this.cookieJar.getHeader(),
                'X-CSRF-TOKEN': csrfToken,
                'User-Agent': USER_AGENT,
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Origin': ORIGIN,
                'Referer': initialUrl
            },
            body: params
        });

        if (!postResponse.ok) {
            const errText = await postResponse.text();
            throw new Error(`❌ Login POST failed: ${postResponse.status} ${postResponse.statusText} - ${errText.substring(0, 200)}`);
        }

        const responseBody = await postResponse.json();
        console.log('📬 Login Response Status:', responseBody.status);

        // Update cookies from POST response
        this.cookieJar.update(postResponse.headers.getSetCookie());

        // Check S value in new trans cookie
        transCookie = this.cookieJar.get('x-ms-cpim-trans');

        if (!transCookie) {
            throw new Error('❌ x-ms-cpim-trans cookie not found in login response');
        }

        const newDecoded = Buffer.from(transCookie, 'base64').toString('utf-8');
        const newJson = JSON.parse(newDecoded);

        // Extract new TID and construct new txParam
        const newTid = newJson.C_ID;

        if (!newTid) {
            throw new Error('❌ Could not extract TID from new x-ms-cpim-trans cookie');
        }

        const newTxData = { TID: newTid };
        const newTxJson = JSON.stringify(newTxData).replace(/\s/g, '');
        txParam = Buffer.from(newTxJson).toString('base64');

        // 3. Call 'confirmed' endpoint
        console.log('📞 Calling confirmed endpoint...');
        const confirmedUrl = `${CONFIRMED_URL}?csrf_token=${encodeURIComponent(csrfToken)}&tx=StateProperties=${txParam}&p=${POLICY}`;

        const confirmedResponse = await fetch(confirmedUrl, {
            method: 'GET',
            headers: {
                'Cookie': this.cookieJar.getHeader(),
                'User-Agent': USER_AGENT,
            },
            redirect: 'manual'
        });

        console.log(`✅ Confirmed Response Status: ${confirmedResponse.status}`);

        let redirectUrl;
        if (confirmedResponse.status === 302 || confirmedResponse.status === 301) {
            redirectUrl = confirmedResponse.headers.get('location');
        } else {
            throw new Error(`❌ Confirmed endpoint did not redirect (Status: ${confirmedResponse.status}).`);
        }

        if (!redirectUrl) {
            throw new Error('❌ No Location header found');
        }

        console.log(`🔗 Redirect URL: ${redirectUrl}`);

        // Extract Code
        const redirectObj = new URL(redirectUrl);
        let code;
        if (redirectObj.hash) {
            const hashParams = new URLSearchParams(redirectObj.hash.substring(1));
            code = hashParams.get('code');
        }
        if (!code) {
            code = redirectObj.searchParams.get('code');
        }

        if (!code) {
            throw new Error('❌ Authorization Code not found in redirect URL');
        }

        console.log(`🎟️ Authorization Code: ${code}`);

        // 4. Exchange Code for Token
        console.log('🔄 Exchanging code for token...');

        const tokenParams = new URLSearchParams();
        tokenParams.append('client_id', CLIENT_ID);
        tokenParams.append('scope', SCOPE);
        tokenParams.append('redirect_uri', REDIRECT_URI);
        tokenParams.append('grant_type', 'authorization_code');
        tokenParams.append('code', code);
        tokenParams.append('code_verifier', codeVerifier);

        const tokenResponse = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': USER_AGENT,
                'Origin': ORIGIN
            },
            body: tokenParams
        });

        const tokenBody = await tokenResponse.json();
        console.log(`✅ Token Response Status: ${tokenResponse.status}`);

        if (!tokenBody.access_token) {
            throw new Error('❌ No access_token found in token response');
        }

        this.accessToken = tokenBody.access_token;
        console.log('🔑 Access Token retrieved successfully.');
    }

    /**
     * Fetches the bill history for the account via GraphQL and retrieves bills from the last 2 years.
     *
     * @returns {Promise<Array>} - An array of bill objects.
     * @throws {Error} If not authenticated or no bills are found.
     */
    async getBillHistory() {
        if (!this.accessToken) {
            throw new Error('❌ Not authenticated. Call login() first.');
        }

        console.log('📊 Fetching Bill History...');

        // Calculate date: 2 years ago + 1 day
        const today = new Date();
        const pastDate = new Date(today);
        pastDate.setFullYear(today.getFullYear() - 2);
        pastDate.setDate(pastDate.getDate() + 1);
        const dateForNumberOfDaysAgo = pastDate.toISOString().split('T')[0];
        console.log(`📅 Calculated Date for History: ${dateForNumberOfDaysAgo}`);

        const gqlUrl = `${MY_ACCOUNT_URL}/api/bill-cu-uwp-gql`;
        const gqlQuery = {
            query: `
                query BillHistory($accountNumber: String!, $dateForNumberOfDaysAgo: Date!) {
                    Bills: bills(
                        accountNumber: $accountNumber
                        order: [{statementDate: DESC}]
                        where: {statementDate: {gte: $dateForNumberOfDaysAgo}, status: {eq: BILLED}}
                    ) {
                        nodes {
                            statementDate
                            totalDueAmount
                            billDuration {
                                fromDate
                                toDate
                            }
                            energyUsages {
                                nodes {
                                    usageType
                                }
                            }
                        }
                    }
                }
            `,
            variables: {
                accountNumber: this.accountNumber,
                dateForNumberOfDaysAgo: dateForNumberOfDaysAgo
            }
        };

        const gqlResponse = await fetch(gqlUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Ocp-Apim-Subscription-Key': this.subscriptionKey,
                'Account-Number': this.accountNumber,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(gqlQuery)
        });

        console.log(`✅ Bill History Response Status: ${gqlResponse.status}`);

        if (!gqlResponse.ok) {
            throw new Error(`❌ ⚠️ Failed to fetch bill history: ${gqlResponse.status}`);
        }

        const historyData = await gqlResponse.json();
        const bills = historyData.data?.Bills?.nodes || [];
        const billCount = bills.length;
        console.log(`📉 Found ${billCount} bills in history.`);

        if (!billCount) {
            throw new Error('❌ ⚠️ No bills found in history.');
        }

        return bills;
    }

    /**
     * Retrieves the most recent bill PDF and automatically logs in if not already authenticated.
     *
     * @returns {Promise<{buffer: Buffer, fileName: string, date: string}>} - The PDF data and metadata.
     */
    async getCurrentBill() {
        if (!this.accessToken) {
            await this.login();
        }

        const bills = await this.getBillHistory();
        const latestBillDate = bills[0].statementDate;
        console.log(`📅 Using latest bill date: ${latestBillDate}`);

        console.log(`📄 Retrieving Bill PDF for date: ${latestBillDate}...`);
        const billUrl = `${MY_ACCOUNT_URL}/api/bill-cu-uwp-sys/v1/bills/view-pdf/${latestBillDate}`;

        const headers = {
            'Authorization': `Bearer ${this.accessToken}`,
            'Ocp-Apim-Subscription-Key': this.subscriptionKey,
            'Account-Number': this.accountNumber
        };

        const billResponse = await fetch(billUrl, {
            method: 'GET',
            headers: headers
        });

        console.log(`✅ Bill PDF Response Status: ${billResponse.status}`);

        if (billResponse.ok) {
            return {
                buffer: Buffer.from(await billResponse.arrayBuffer()),
                fileName: `NG_Bill_${latestBillDate}.pdf`,
                date: latestBillDate
            };
        } else {
            const errText = await billResponse.text();
            console.log('❌ Bill PDF Error Body:', errText.substring(0, 500));

            if (billResponse.status === 401 || billResponse.status === 403) {
                console.error('\n🚫 AUTHENTICATION ERROR: The Subscription Key may have expired or changed.');
                console.error(`👉 Please check the "Ocp-Apim-Subscription-Key" header in your browser's network tab for ${MY_ACCOUNT_URL} and update the subscriptionKey in NATIONAL_GRID_CREDENTIALS.\n`);
            }

            throw new Error(`❌ Failed to retrieve bill PDF: ${billResponse.status}`);
        }
    }

    /**
     * Downloads the most recent bill PDF and saves it to the current working directory.
     * This is primarily for CLI usage.
     *
     * @returns {Promise<string>} - The absolute path to the saved file.
     */
    async downloadCurrentBill() {
        const { buffer, fileName } = await this.getCurrentBill();
        const filePath = path.join(process.cwd(), fileName);
        fs.writeFileSync(filePath, buffer);
        console.log(`💾 SUCCESS: Bill PDF saved to ${filePath} (${buffer.byteLength} bytes)`);
        return filePath;
    }
}
