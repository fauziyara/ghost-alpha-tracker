// Vercel Serverless Function — Real GENIUS Token Transfers from BSC RPC
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const GENIUS_CONTRACT = '0x1f12b85aac097e43aa1555b2881e98a51090e9a6';
const RPC_ENDPOINTS = [
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
];

async function rpcCall(method, params) {
  for (const rpc of RPC_ENDPOINTS) {
    try {
      const resp = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
      });
      const data = await resp.json();
      if (!data.error) return data.result;
    } catch (e) { continue; }
  }
  return null;
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    // Get latest block
    const latestHex = await rpcCall('eth_blockNumber', []);
    if (!latestHex) return res.status(500).json({ error: 'Cannot fetch block number' });
    const latestBlock = parseInt(latestHex, 16);

    // Fetch logs in chunks (BSC RPC limits ~5 blocks per request)
    const BLOCKS_TO_SCAN = 50;
    const CHUNK_SIZE = 5;
    const allLogs = [];

    for (let i = 0; i < BLOCKS_TO_SCAN; i += CHUNK_SIZE) {
      const fromBlock = latestBlock - BLOCKS_TO_SCAN + i;
      const toBlock = Math.min(fromBlock + CHUNK_SIZE - 1, latestBlock);
      
      try {
        const logs = await rpcCall('eth_getLogs', [{
          fromBlock: '0x' + fromBlock.toString(16),
          toBlock: '0x' + toBlock.toString(16),
          address: GENIUS_CONTRACT,
          topics: [TRANSFER_TOPIC],
        }]);
        if (logs && Array.isArray(logs)) allLogs.push(...logs);
      } catch (e) { continue; }
    }

    // Decode transfer logs
    const transfers = allLogs.map(log => {
      const from = '0x' + log.topics[1].slice(-40);
      const to = '0x' + log.topics[2].slice(-40);
      const amount = parseInt(log.data || '0x0', 16);
      const amountHuman = amount / 1e18;
      const block = parseInt(log.blockNumber, 16);
      const txHash = log.transactionHash;
      return { from, to, amount: amountHuman, block, txHash };
    }).filter(t => t.amount > 0);

    // Sort by block descending
    transfers.sort((a, b) => b.block - a.block);

    // Detect ghost orders: same source wallet, multiple destinations in short time
    const sourceGroups = {};
    transfers.forEach(t => {
      if (!sourceGroups[t.from]) sourceGroups[t.from] = [];
      sourceGroups[t.from].push(t);
    });

    const ghostOrders = [];
    Object.entries(sourceGroups).forEach(([source, txns]) => {
      if (txns.length >= 3) {
        const uniqueDestinations = new Set(txns.map(t => t.to)).size;
        if (uniqueDestinations >= 3) {
          const totalVolume = txns.reduce((s, t) => s + t.amount, 0);
          const blockSpan = Math.max(...txns.map(t => t.block)) - Math.min(...txns.map(t => t.block));
          ghostOrders.push({
            source: source,
            splits: txns.length,
            destinations: uniqueDestinations,
            totalVolume,
            blockSpan,
            confidence: Math.min(99, 70 + txns.length * 3),
            side: 'BUY', // heuristic
            transfers: txns.slice(0, 10),
          });
        }
      }
    });

    return res.status(200).json({
      latestBlock,
      totalTransfers: transfers.length,
      transfers: transfers.slice(0, 20),
      ghostOrders,
      scannedBlocks: BLOCKS_TO_SCAN,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
