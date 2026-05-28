// Vercel Serverless Function — Real GENIUS Token Transfers from BSC RPC
// Parallel block scanning for speed

const GENIUS_CONTRACT = '0x1f12b85aac097e43aa1555b2881e98a51090e9a6'.toLowerCase();
const TRANSFER_SIG = '0xa9059cbb';

const RPCS = [
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
];

let rpcIdx = 0;
async function rpc(method, params) {
  for (let i = 0; i < RPCS.length; i++) {
    const url = RPCS[(rpcIdx + i) % RPCS.length];
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 8000);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
        signal: c.signal,
      });
      clearTimeout(t);
      const d = await r.json();
      if (!d.error) { rpcIdx = (rpcIdx + i) % RPCS.length; return d.result; }
    } catch (e) { continue; }
  }
  return null;
}

function decodeTransfers(block) {
  if (!block?.transactions) return [];
  const out = [];
  for (const tx of block.transactions) {
    if (!tx.to || tx.to.toLowerCase() !== GENIUS_CONTRACT) continue;
    if (!tx.input?.startsWith(TRANSFER_SIG)) continue;
    try {
      const d = tx.input.slice(10);
      const to = '0x' + d.slice(24, 64);
      const amt = parseInt('0x' + d.slice(64, 128), 16) / 1e18;
      if (amt > 0) out.push({
        from: tx.from.toLowerCase(), to: to.toLowerCase(),
        amount: amt, block: parseInt(block.number, 16), txHash: tx.hash,
      });
    } catch (e) {}
  }
  return out;
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30');

  try {
    const latestHex = await rpc('eth_blockNumber', []);
    if (!latestHex) return res.status(500).json({ error: 'BSC RPC unreachable' });
    const latest = parseInt(latestHex, 16);

    // Scan 100 blocks in parallel batches of 10
    const BLOCKS = 100;
    const BATCH = 10;
    const allTransfers = [];

    for (let i = 0; i < BLOCKS; i += BATCH) {
      const batch = [];
      for (let j = 0; j < BATCH && i + j < BLOCKS; j++) {
        const num = latest - i - j;
        batch.push(
          rpc('eth_getBlockByNumber', ['0x' + num.toString(16), true])
            .then(b => decodeTransfers(b))
        );
      }
      const results = await Promise.all(batch);
      results.forEach(t => allTransfers.push(...t));
    }

    allTransfers.sort((a, b) => b.block - a.block);

    // Detect ghost orders
    const groups = {};
    allTransfers.forEach(t => {
      if (!groups[t.from]) groups[t.from] = [];
      groups[t.from].push(t);
    });

    const ghostOrders = [];
    Object.entries(groups).forEach(([src, txns]) => {
      const dests = new Set(txns.map(t => t.to)).size;
      if (txns.length >= 2 && dests >= 2) {
        const vol = txns.reduce((s, t) => s + t.amount, 0);
        const blocks = txns.map(t => t.block);
        ghostOrders.push({
          source: src, splits: txns.length, destinations: dests,
          totalVolume: vol,
          blockSpan: Math.max(...blocks) - Math.min(...blocks),
          confidence: Math.min(99, 70 + txns.length * 5),
          side: 'BUY', transfers: txns.slice(0, 10),
        });
      }
    });
    ghostOrders.sort((a, b) => b.totalVolume - a.totalVolume);

    return res.status(200).json({
      latestBlock: latest, totalTransfers: allTransfers.length,
      transfers: allTransfers.slice(0, 20),
      ghostOrders: ghostOrders.slice(0, 10),
      scannedBlocks: BLOCKS,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
