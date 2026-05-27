const https = require('https');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const BSCSCAN_KEY = 'D5P783P75IJJPYSDYR6K2N9CNVSC5VR2TA';
    const CONTRACT = '0x1f12b85aac097e43aa1555b2881e98a51090e9a6';

    const url = `https://api.bscscan.com/api?module=account&action=tokentx&contractaddress=${CONTRACT}&page=1&offset=20&sort=desc&apikey=${BSCSCAN_KEY}`;

    return new Promise((resolve) => {
        https.get(url, (apiRes) => {
            let data = '';
            apiRes.on('data', chunk => data += chunk);
            apiRes.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate');
                    res.status(200).json(json);
                } catch (e) {
                    res.status(500).json({ error: 'Parse error', raw: data.slice(0, 200) });
                }
                resolve();
            });
        }).on('error', (err) => {
            res.status(500).json({ error: err.message });
            resolve();
        });
    });
};
