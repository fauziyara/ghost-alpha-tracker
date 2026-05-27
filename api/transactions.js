export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const BSCSCAN_KEY = 'D5P783P75IJJPYSDYR6K2N9CNVSC5VR2TA';
    const CONTRACT = '0x1f12b85aac097e43aa1555b2881e98a51090e9a6';
    const offset = req.query.offset || '20';

    try {
        const url = `https://api.bscscan.com/api?module=account&action=tokentx&contractaddress=${CONTRACT}&page=1&offset=${offset}&sort=desc&apikey=${BSCSCAN_KEY}`;
        const r = await fetch(url);
        const data = await r.json();

        res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate');
        return res.status(200).json(data);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch', message: err.message });
    }
}
