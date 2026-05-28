// Vercel Serverless Function — Real GENIUS Token Transfers from BSC RPC
// Uses eth_getBlockByNumber instead of eth_getLogs (which is rate-limited on public RPCs)

const GENIUS_CONTRACT = '0x1f12b85aac097e43aa1555b2881e98a51090e9a6'.toLowerCase();
const TRANSFER_SIG = '0xa9059cbb'; // transfer(address,uint256)
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const RPC_ENDPOINTS = [
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
];

let rpcIndex = 0;

async function rpcCall(method, params) {
  for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
    const rpc = RPC_ENDPOINTS[(rpcIndex + i) % RPC_ENDPOINTS.length];
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      
      const resp = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      
      const data = await resp.json();
      if (!data.error) {
        rpcIndex = (rpcIndex + i) % RPC_ENDPOINTS.length;
        return data.result;
      }
    } catch (e) { continue; }
  }
  return null;
}

async function tryGetLogs(fromBlock, toBlock) {
  try {
    const logs = await rpcCall('eth_getLogs', [{
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + toBlock.toString(16),
      address: GENIUS_CONTRACT,
      topics: [TRANSFER_TOPIC],
    }]);
    return Array.isArray(logs) ? logs : [];
  } catch (e) { return []; }
}

async function getBlockTransfers(blockNum) {
  const blockHex = '0x' + blockNum.toString(16);
  const block = await rpcCall('eth_getBlockByNumber', [blockHex, true]);
  if (!block || !block.transactions) return [];
  
  const transfers = [];
  for (const tx of block.transactions) {
    if (!tx.to) continue;
    if (tx.to.toLowerCase() !== GENIUS_CONTRACT) continue;
    if (!tx.input || !tx.input.startsWith(TRANSFER_SIG)) continue;
    
    try {
      // Decode transfer(address to, uint256 amount)
      const data = tx.input.slice(10); // remove selector
      const toAddr = '0x' + data.slice(24, 64);
      const amountHex = '0x' + data.slice(64, 128);
      const amount = parseInt(amountHex, 16) / 1e18;
      
      if (amount > 0) {
        transfers.push({
          from: tx.from,
          to: toAddr,
          amount,
          block: blockNum,
          txHash: tx.hash,
        });
      }
    } catch (e) { continue; }
  }
  return transfers;
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=30');

  try {
    const latestHex = await rpcCall('eth_blockNumber', []);
    if (!latestHex) return res.status(500).json({ error: 'Cannot reach BSC RPC' });
    const latestBlock = parseInt(latestHex, 16);

    // Strategy 1: Try eth_getLogs first (fast)
    const BLOCKS_TO_SCAN = 100;
    let allLogs = [];
    
    // Try small chunks
    for (let i = 0; i < BLOCKS_TO_SCAN; i += 3) {
      const from = latestBlock - BLOCKS_TO_SCAN + i;
      const to = Math.min(from + 2, latestBlock);
      const logs = await tryGetLogs(from, to);
      if (logs.length > 0) allLogs.push(...logs);
      // Small delay to avoid rate limit
      if (i % 9 === 0 && i > 0) await new Promise(r => setTimeout(r, 200));
    }

    // Strategy 2: If getLogs returned nothing, scan blocks directly
    if (allLogs.length === 0) {
      const blocksToScan = 30; // Scan fewer blocks (expensive)
      const transfers = [];
      
      for (let i = 0; i < blocksToScan; i++) {
        const blockNum = latestBlock - i;
        const blockTransfers = await getBlockTransfers(blockNum);
        if (blockTransfers.length > 0) transfers.push(...blockTransfers);
        if (i % 10 === 0 && i > 0) await new Promise(r => setTimeout(r, 200));
      }
      
      if (transfers.length > 0) {
        // Build ghost orders from transfers
        const sourceGroups = {};
        transfers.forEach(t => {
          if (!sourceGroups[t.from]) sourceGroups[t.from] = [];
          sourceGroups[t.from].push(t);
        });

        const ghostOrders = [];
        Object.entries(sourceGroups).forEach(([source, txns]) => {
          const uniqueDestinations = new Set(txns.map(t => t.to)).size;
          if (txns.length >= 2 && uniqueDestinations >= 2) {
            const totalVolume = txns.reduce((s, t) => s + t.amount, 0);
            const blockSpan = Math.max(...txns.map(t => t.block)) - Math.min(...txns.map(t => t.block));
            ghostOrders.push({
              source, splits: txns.length, destinations: uniqueDestinations,
              totalVolume, blockSpan,
              confidence: Math.min(99, 70 + txns.length * 5),
              side: 'BUY', transfers: txns.slice(0, 10),
            });
          }
        });

        return res.status(200).json({
          latestBlock, totalTransfers: transfers.length,
          transfers: transfers.sort((a, b) => b.block - a.block).slice(0, 20),
          ghostOrders, scannedBlocks: blocksToScan,
          method: 'block-scan',
        });
      }
    }

    // Process getLogs results
    const transfers = allLogs.map(log => {
      const from = '0x' + (log.topics?.[1] || '').slice(-40);
      const to = '0x' + (log.topics?.[2] || '').slice(-40);
      const amount = parseInt(log.data || '0x0', 16) / 1e18;
      const block = parseInt(log.blockNumber, 16);
      return { from, to, amount, block, txHash: log.transactionHash };
    }).filter(t => t.amount > 0);

    // Build ghost orders
    const sourceGroups = {};
    transfers.forEach(t => {
      if (!sourceGroups[t.from]) sourceGroups[t.from] = [];
      sourceGroups[t.from].push(t);
    });

    const ghostOrders = [];
    Object.entries(sourceGroups).forEach(([source, txns]) => {
      const uniqueDestinations = new Set(txns.map(t => t.to)).size;
      if (txns.length >= 2 && uniqueDestinations >= 2) {
        const totalVolume = txns.reduce((s, t) => s + t.amount, 0);
        const blockSpan = Math.max(...txns.map(t => t.block)) - Math.min(...txns.map(t => t.block));
        ghostOrders.push({
          source, splits: txns.length, destinations: uniqueDestinations,
          totalVolume, blockSpan,
          confidence: Math.min(99, 70 + txns.length * 5),
          side: 'BUY', transfers: txns.slice(0, 10),
        });
      }
    });

    return res.status(200).json({
      latestBlock, totalTransfers: transfers.length,
      transfers: transfers.sort((a, b) => b.block - a.block).slice(0, 20),
      ghostOrders, scannedBlocks: BLOCKS_TO_SCAN,
      method: 'getLogs',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
