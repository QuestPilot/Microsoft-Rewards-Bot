const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DASHBOARD_URL = 'https://rewards.bing.com/dashboard';

function loadCookiesFor(email) {
    const cookieFile = path.join(process.cwd(), 'sessions', email, 'session_mobile.json');
    if (!fs.existsSync(cookieFile)) {
        console.error(`No mobile session found for ${email} at ${cookieFile}`);
        return null;
    }
    try {
        const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
        if (Array.isArray(cookies)) {
            return cookies.map(c => `${c.name}=${c.value}`).join('; ');
        }
    } catch (e) {
        console.error(`Error parsing cookies for ${email}: ${e.message}`);
    }
    return null;
}

async function testAxiosDashboard(email) {
    console.log(`\n--- Testing ${email} ---`);
    const cookieHeader = loadCookiesFor(email);
    if (!cookieHeader) return;

    try {
        const response = await axios.get(DASHBOARD_URL, {
            headers: {
                'Cookie': cookieHeader,
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            },
            maxRedirects: 10
        });

        const finalUrl = response.request.res?.responseUrl || response.request._redirectable?._currentUrl || response.config.url;
        const body = response.data || '';

        console.log(`Final Status: ${response.status}`);
        console.log(`Final URL: ${finalUrl}`);
        console.log(`Contains self.__next_f: ${body.includes('self.__next_f')}`);
        console.log(`Contains userStatus: ${body.includes('userStatus')}`);
        console.log(`Contains <section: ${body.includes('<section')}`);

    } catch (error) {
        if (error.response) {
            console.log(`Error Response Status: ${error.response.status}`);
            const finalUrl = error.request?.res?.responseUrl || error.request?._redirectable?._currentUrl || error.config?.url;
            console.log(`Error Final URL: ${finalUrl}`);
            const body = error.response.data || '';
            if (typeof body === 'string') {
                console.log(`Contains self.__next_f: ${body.includes('self.__next_f')}`);
                console.log(`Contains userStatus: ${body.includes('userStatus')}`);
                console.log(`Contains <section: ${body.includes('<section')}`);
            }
        } else {
            console.error(`Request failed: ${error.message}`);
        }
    }
}

async function main() {
    await testAxiosDashboard('email_1');
    await testAxiosDashboard('nguyenthithungan28033@gmail.com');
}

main();
