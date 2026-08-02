import { normalizeWalletTokenProfit } from '../robinhood/debotClient.js';
import { isBscAddress, normalizeBscAddress } from './config.js';

const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead'
]);

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = number(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function stringList(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function trueFlag(value) {
  return value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true';
}

function exclusionReasons(row, wallet) {
  const tags = stringList(row?.tags);
  const labels = [row?.type, row?.wallet_type, row?.label, row?.name]
    .filter((value) => typeof value === 'string')
    .map((value) => value.toLowerCase());
  const descriptors = [...tags, ...labels].join(' ');
  const reasons = [];
  if (BURN_ADDRESSES.has(wallet)) reasons.push('burn_address');
  if (trueFlag(row?.is_contract) || /(?:^|\b)(?:contract|router)(?:\b|$)/.test(descriptors)) {
    reasons.push('contract_holder');
  }
  if (
    trueFlag(row?.is_pair) || trueFlag(row?.is_pool) || trueFlag(row?.is_lp) ||
    /(?:^|\b)(?:pair|pool|liquidity|lp)(?:\b|$)/.test(descriptors)
  ) reasons.push('liquidity_pool');
  if (trueFlag(row?.is_burn) || /(?:^|\b)(?:burn|dead)(?:\b|$)/.test(descriptors)) {
    reasons.push('burn_address');
  }
  if (
    /(?:^|\b)(?:cex|centralized exchange|exchange|binance|coinbase|okx|bybit|kucoin|mexc|bitget|gate(?:\.io)?|htx|huobi|crypto\.com|bridge|factory|locker|vesting|treasury|multicall)(?:\b|$)/.test(descriptors)
  ) {
    reasons.push('service_holder');
  }
  return [...new Set(reasons)];
}

function holderSharePercent(row) {
  const explicitPercent = firstNumber(
    row?.holding_share_percent,
    row?.holding_percent,
    row?.position_percent,
    row?.hold_percent
  );
  const value = explicitPercent ?? (number(row?.percent) === null ? null : number(row.percent) * 100);
  return value === null ? null : Math.min(100, Math.max(0, value));
}

function meaningfulProfit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return [
    'buy_volume',
    'buy_amount',
    'buy_times',
    'sell_volume',
    'sell_amount',
    'sell_times',
    'actual_buy_amount',
    'actual_buy_cost',
    'realized_profit',
    'unrealized_profit',
    'total_profit'
  ].some((field) => {
    const parsed = number(value[field]);
    return parsed !== null && parsed !== 0;
  });
}

// DeBot uses an all-zero, complete-shaped profit object for holders without
// recorded trades. Keep that signal so the scanner can skip a doomed
// per-wallet request instead of turning it into a bridge failure.
function hasExplicitZeroProfit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return [
    'buy_volume',
    'buy_amount',
    'buy_times',
    'sell_volume',
    'sell_amount',
    'sell_times',
    'actual_buy_amount',
    'actual_buy_cost',
    'realized_profit',
    'unrealized_profit',
    'total_profit'
  ].every((field) => Object.hasOwn(value, field) && number(value[field]) === 0);
}

function contractCode(value) {
  const code = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(code)) throw new Error('BSC RPC returned invalid contract code');
  if (/^0x0*$/.test(code)) return false;
  return !/^0xef0100[0-9a-f]{40}$/.test(code);
}

export class BscDebotHolderClient {
  constructor({ debotClient, rpcClient, infrastructureAddresses = [], rpcBatchSize = 20 } = {}) {
    if (typeof debotClient?.fetchTokenHolderProfile !== 'function') {
      throw new TypeError('A DeBot BSC Holder profile client is required');
    }
    if (typeof rpcClient?.batchRequest !== 'function') {
      throw new TypeError('A BSC RPC client is required to verify Holder wallet code');
    }
    this.debotClient = debotClient;
    this.rpcClient = rpcClient;
    this.infrastructureAddresses = new Set(
      infrastructureAddresses.map(normalizeBscAddress).filter(isBscAddress)
    );
    this.rpcBatchSize = Math.max(1, Math.min(50, Math.floor(Number(rpcBatchSize) || 20)));
  }

  async fetchTopHolders(tokenAddress, { limit = 100, signal } = {}) {
    const address = normalizeBscAddress(tokenAddress);
    if (!isBscAddress(address)) throw new TypeError('Invalid BSC token address');
    const target = Math.max(1, Math.min(100, Math.floor(Number(limit) || 100)));
    const raw = await this.debotClient.fetchTokenHolderProfile(address, { limit: target, signal });
    const rows = Array.isArray(raw?.list) ? raw.list : [];
    const snapshotAt = new Date().toISOString();
    const holders = rows.flatMap((row, index) => {
      const wallet = normalizeBscAddress(row?.wallet || row?.address);
      if (!isBscAddress(wallet)) return [];
      const zeroProfit = hasExplicitZeroProfit(row?.profit);
      const rawProfit = meaningfulProfit(row?.profit) || zeroProfit ? row.profit : null;
      const holdingTokenAmount = firstNumber(
        row?.position,
        row?.holding_token_amount,
        row?.holding_amount,
        row?.token_amount,
        rawProfit?.position,
        rawProfit?.hold_amount
      );
      const holdingValueUsd = firstNumber(
        row?.balance,
        row?.holding_value_usd,
        row?.position_value_usd,
        row?.balance_usd
      );
      const currentPrice = holdingTokenAmount > 0 && holdingValueUsd !== null
        ? holdingValueUsd / holdingTokenAmount
        : null;
      const actualBuyAmount = firstNumber(rawProfit?.actual_buy_amount);
      const actualBuyCost = firstNumber(rawProfit?.actual_buy_cost);
      const averageBuyPrice = actualBuyAmount > 0 && actualBuyCost !== null
        ? actualBuyCost / actualBuyAmount
        : null;
      const walletTokenProfit = rawProfit ? normalizeWalletTokenProfit({
        ...rawProfit,
        chain: 'bsc',
        wallet,
        token: address,
        position: holdingTokenAmount ?? rawProfit.position,
        balance: holdingValueUsd ?? rawProfit.balance,
        price: firstNumber(rawProfit.price, currentPrice),
        avg_buy_price: firstNumber(rawProfit.avg_buy_price, averageBuyPrice)
      }, wallet, { chain: 'bsc', addressNormalizer: normalizeBscAddress }) : null;
      if (walletTokenProfit && zeroProfit) walletTokenProfit.noTradeHistory = true;
      const reasons = exclusionReasons(row, wallet);
      if (this.infrastructureAddresses.has(wallet)) reasons.push('known_infrastructure');
      return [{
        address: wallet,
        holderRank: Math.max(1, Math.floor(firstNumber(row?.rank, row?.holder_rank, index + 1) || index + 1)),
        holdingTokenAmount,
        holdingValueUsd,
        holdingSharePercent: holderSharePercent(row),
        exclusionReasons: [...new Set(reasons)],
        ...(walletTokenProfit ? { walletTokenProfit } : {}),
        holderSnapshotAt: snapshotAt,
        holderSource: 'debot_token_holder_profile'
      }];
    }).slice(0, target);
    if (!holders.length) {
      const error = new Error('DeBot BSC Holder profile returned no valid wallet rows');
      error.code = 'BSC_DEBOT_HOLDER_PROFILE_EMPTY';
      throw error;
    }
    try {
      for (let index = 0; index < holders.length; index += this.rpcBatchSize) {
        const chunk = holders.slice(index, index + this.rpcBatchSize);
        const codes = await this.rpcClient.batchRequest(
          chunk.map((holder) => ({ method: 'eth_getCode', params: [holder.address, 'latest'] })),
          { signal }
        );
        if (!Array.isArray(codes) || codes.length !== chunk.length) {
          throw new Error('BSC RPC returned an incomplete contract verification batch');
        }
        codes.forEach((code, codeIndex) => {
          if (!contractCode(code)) return;
          const holder = chunk[codeIndex];
          holder.exclusionReasons = [...new Set([...holder.exclusionReasons, 'contract_holder'])];
        });
      }
    } catch (cause) {
      const error = new Error('BSC Holder wallet contract verification failed', { cause });
      error.code = 'BSC_HOLDER_EOA_CHECK_FAILED';
      throw error;
    }
    const explicitTotal = firstNumber(raw?.total, raw?.count, raw?.holders);
    const returnedSourceRows = Math.min(rows.length, target);
    const total = Math.max(rows.length, Math.floor(explicitTotal ?? rows.length));
    const explicitHasMore = trueFlag(
      raw?.has_more ?? raw?.hasMore ?? raw?.pagination?.has_more ?? raw?.pagination?.hasMore
    );
    const denominatorPartial = explicitHasMore || rows.length > target || (explicitTotal !== null
      ? explicitTotal > returnedSourceRows
      : rows.length >= target);
    const walletHolders = holders.filter((holder) => holder.exclusionReasons.length === 0);
    return {
      token: { address, holders: total },
      holders: walletHolders,
      requested: target,
      sourceRows: rows.length,
      excludedRows: holders.length - walletHolders.length,
      reachedEnd: !denominatorPartial,
      partial: denominatorPartial,
      denominatorPartial,
      complete: !denominatorPartial,
      snapshotAt,
      source: 'debot_token_holder_profile'
    };
  }
}
