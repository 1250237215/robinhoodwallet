import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWalletSummaries,
  deriveTokenQualification,
  discoveryMultiple,
  estimateV2Exit,
  reliablePriceStats
} from '../src/robinhood/qualification.js';

const tokenA = '0x1111111111111111111111111111111111111111';
const tokenB = '0x2222222222222222222222222222222222222222';
const tokenC = '0x3333333333333333333333333333333333333333';
const walletA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const walletB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const walletC = '0xcccccccccccccccccccccccccccccccccccccccc';
const walletD = '0xdddddddddddddddddddddddddddddddddddddddd';

function action({ token = tokenA, wallet, side, amount = 100, quote, price, block, timestamp }) {
  return {
    tokenAddress: token,
    wallet,
    side,
    tokenAmount: amount,
    quoteAmount: quote ?? amount * price,
    priceNative: price,
    blockNumber: block,
    blockTimestamp: timestamp ?? block,
    transactionIndex: 0,
    logIndex: 0,
    attributionConfidence: 'high'
  };
}

test('uses the first price after two unrelated wallets and derives a verified winner', () => {
  const actions = [
    action({ wallet: walletA, side: 'buy', price: 0.001, block: 1 }),
    action({ wallet: walletB, side: 'buy', price: 0.002, block: 2 }),
    action({ wallet: walletA, side: 'sell', price: 0.04, block: 3 })
  ];
  const stats = reliablePriceStats(actions);
  const qualification = deriveTokenQualification({
    token: { address: tokenA, liquidityUsd: 80_000, effectiveWallets: 999 },
    actions,
    scanComplete: true
  });

  assert.equal(stats.initialPriceNative, 0.002);
  assert.equal(stats.peakMultiple, 20);
  assert.equal(qualification.status, 'below_threshold');
  assert.equal(qualification.effectiveWallets, 2);
  assert.equal(qualification.walletCountSource, 'onchain_distinct_tx_senders');
});

test('keeps DeBot change windows explicit as provisional discovery multiples', () => {
  assert.equal(discoveryMultiple({ change24hPercent: 900 }), 10);
  const qualification = deriveTokenQualification({
    token: { address: tokenA, change24hPercent: 4900, liquidityUsd: 100_000, effectiveWallets: 300 },
    actions: [],
    scanComplete: false
  });
  assert.equal(qualification.peakMultiple, 50);
  assert.equal(qualification.qualified, true);
  assert.equal(qualification.provisional, true);
  assert.equal(qualification.priceSource, 'debot_change_window');
});

test('does not let an incomplete onchain prefix erase a larger DeBot discovery multiple', () => {
  const qualification = deriveTokenQualification({
    token: { address: tokenA, change24hPercent: 4900, liquidityUsd: 100_000, effectiveWallets: 300 },
    actions: [
      action({ wallet: walletA, side: 'buy', price: 1, block: 1 }),
      action({ wallet: walletB, side: 'buy', price: 2, block: 2 }),
      action({ wallet: walletA, side: 'sell', price: 4, block: 3 })
    ],
    scanComplete: false
  });
  assert.equal(qualification.peakMultiple, 50);
  assert.equal(qualification.priceSource, 'partial_onchain_and_debot');
});

test('keeps a thin verified current pool pending despite a contradictory advisory liquidity value', () => {
  const qualification = deriveTokenQualification({
    token: {
      address: tokenA,
      change24hPercent: 4900,
      liquidityUsd: 60_000,
      effectiveWallets: 300,
      pool: { verifiedLiquidityUsd: 3 }
    },
    actions: [],
    scanComplete: false
  });

  assert.equal(qualification.qualified, false);
  assert.equal(qualification.status, 'pending_data');
  assert.equal(qualification.peakLiquidityUsd, 3);
  assert.equal(qualification.checks.liquidity, null);
  assert.equal(qualification.liquidityMismatch, true);
});

test('simulates a V2 full exit separately from mark value', () => {
  const exit = estimateV2Exit({ amountIn: 100, reserveIn: 1_000, reserveOut: 100, feeBps: 30 });
  assert.equal(exit.amountOut < exit.spotValue, true);
  assert.equal(exit.realizableRatio < 1, true);
  assert.equal(exit.priceImpactPercent > 9, true);
});

test('ranks a repeated early high-multiple wallet above one-off and late buyers', () => {
  const tokenRows = [tokenA, tokenB].map((address, index) => ({
    address,
    symbol: index ? 'TWO' : 'ONE',
    qualified: true,
    peakMultiple: 100,
    currentPriceNative: 1,
    creationTimestamp: 0,
    pool: { version: 'v3', currentPriceNative: 1 }
  }));
  const actionsByToken = new Map([
    [tokenA, [
      action({ token: tokenA, wallet: walletA, side: 'buy', amount: 100, price: 0.01, block: 1 }),
      action({ token: tokenA, wallet: walletB, side: 'buy', amount: 10, price: 0.02, block: 2 }),
      action({ token: tokenA, wallet: walletA, side: 'sell', amount: 50, price: 1, block: 3 })
    ]],
    [tokenB, [
      action({ token: tokenB, wallet: walletA, side: 'buy', amount: 100, price: 0.01, block: 1 }),
      action({ token: tokenB, wallet: walletB, side: 'buy', amount: 10, price: 0.02, block: 2 }),
      action({ token: tokenB, wallet: walletA, side: 'sell', amount: 50, price: 1, block: 3 })
    ]]
  ]);

  const summaries = buildWalletSummaries({ tokens: tokenRows, actionsByToken, minimumHitMultiple: 10 });
  const repeated = summaries.find((summary) => summary.address === walletA);
  const late = summaries.find((summary) => summary.address === walletB);
  assert.equal(repeated.winnerHits, 2);
  assert.equal(repeated.maxRealizedMultiple, 100);
  assert.equal(repeated.maxUnrealizedMultiple, 100);
  assert.equal(repeated.classification, 'all_round');
  assert.equal(repeated.score > late.score, true);
});

test('does not count an explicitly pending thin-pool token as a winner hit', () => {
  const actions = [
    action({ wallet: walletA, side: 'buy', price: 0.01, block: 1 }),
    action({ wallet: walletB, side: 'buy', price: 0.02, block: 2 }),
    action({ wallet: walletA, side: 'sell', price: 1, block: 3 })
  ];
  const [summary] = buildWalletSummaries({
    tokens: [{
      address: tokenA,
      symbol: 'THIN',
      currentPriceNative: 1,
      peakMultiple: 100,
      qualificationStatus: 'pending_data',
      qualification: { status: 'pending_data', qualified: false },
      pool: { version: 'v3', currentPriceNative: 1 }
    }],
    actionsByToken: new Map([[tokenA, actions]]),
    minimumHitMultiple: 10
  });
  assert.equal(summary.winnerHits, 0);
});

test('counts user-confirmed manual tokens despite scanner status but still requires a 10x performance', () => {
  const highMultipleActions = (token) => [
    action({ token, wallet: walletA, side: 'buy', amount: 100, price: 0.01, block: 1 }),
    action({ token, wallet: walletB, side: 'buy', amount: 10, price: 0.02, block: 2 }),
    action({ token, wallet: walletA, side: 'sell', amount: 50, price: 1, block: 3 })
  ];
  const summaries = buildWalletSummaries({
    tokens: [
      {
        address: tokenA,
        symbol: 'MANUAL',
        manual: true,
        qualified: false,
        qualificationStatus: 'manual',
        qualification: { status: 'manual', qualified: false },
        currentPriceNative: 1,
        pool: { version: 'v3', currentPriceNative: 1 }
      },
      {
        address: tokenB,
        symbol: 'UNQUALIFIED',
        manual: true,
        qualified: false,
        qualificationStatus: 'below_threshold',
        qualification: { status: 'below_threshold', qualified: false },
        currentPriceNative: 1,
        pool: { version: 'v3', currentPriceNative: 1 }
      },
      {
        address: tokenC,
        symbol: 'LOW',
        manual: true,
        qualified: false,
        qualificationStatus: 'manual',
        qualification: { status: 'manual', qualified: false },
        currentPriceNative: 0.05,
        pool: { version: 'v3', currentPriceNative: 0.05 }
      }
    ],
    actionsByToken: new Map([
      [tokenA, highMultipleActions(tokenA)],
      [tokenB, highMultipleActions(tokenB)],
      [tokenC, [
        action({ token: tokenC, wallet: walletA, side: 'buy', amount: 100, price: 0.01, block: 1 }),
        action({ token: tokenC, wallet: walletB, side: 'buy', amount: 10, price: 0.02, block: 2 }),
        action({ token: tokenC, wallet: walletA, side: 'sell', amount: 50, price: 0.05, block: 3 })
      ]]
    ]),
    minimumHitMultiple: 10
  });

  const smartWallet = summaries.find((summary) => summary.address === walletA);
  assert.equal(smartWallet.winnerHits, 2);
  assert.equal(smartWallet.performances.find((performance) => performance.tokenAddress === tokenA).hit, true);
  assert.equal(smartWallet.performances.find((performance) => performance.tokenAddress === tokenB).hit, true);
  assert.equal(smartWallet.performances.find((performance) => performance.tokenAddress === tokenC).hit, false);
  assert.equal(smartWallet.performances.find((performance) => performance.tokenAddress === tokenC).peakPotentialMultiple, 5);
});

test('ignores wallet-token positions below the cumulative 500 USD entry floor', () => {
  const tokenRows = [{
    address: tokenA,
    symbol: 'FLOOR',
    qualified: true,
    peakMultiple: 100,
    currentPriceNative: 1,
    quoteUsd: 2_000,
    pool: { version: 'v3', currentPriceNative: 1 }
  }];
  const actions = [
    action({ wallet: walletA, side: 'buy', amount: 10, quote: 0.15, price: 0.015, block: 1 }),
    action({ wallet: walletA, side: 'buy', amount: 10, quote: 0.15, price: 0.015, block: 2 }),
    action({ wallet: walletB, side: 'buy', amount: 10, quote: 0.20, price: 0.020, block: 3 })
  ];

  const summaries = buildWalletSummaries({
    tokens: tokenRows,
    actionsByToken: new Map([[tokenA, actions]]),
    minimumHitMultiple: 10,
    minimumEntryUsd: 500
  });

  assert.deepEqual(summaries.map((summary) => summary.address), [walletA]);
  assert.equal(summaries[0].performances[0].entryCostUsd, 600);
  assert.equal(summaries[0].totalEntryCostUsd, 600);
  assert.equal(summaries[0].minimumEntryUsd, 500);
});

test('builds holder-first summaries only from complete candidates above the 500 USD floor', () => {
  const summaries = buildWalletSummaries({
    tokens: [{
      address: tokenA,
      symbol: 'HOLDER',
      manual: true,
      priceUsd: 1,
      holderAnalysis: {
        strategy: 'holder_first',
        complete: false,
        snapshotAt: '2026-07-11T00:00:00.000Z',
        candidates: [
          {
            address: walletA,
            holderRank: 2,
            holdingTokenAmount: 5_000,
            holdingValueUsd: 5_000,
            holdingSharePercent: 0.5,
            buyVolumeUsd: 600,
            sellVolumeUsd: 12_000,
            realizedProfitUsd: 11_400,
            unrealizedProfitUsd: 6_600,
            totalProfitUsd: 18_000,
            realizedMultiple: 20,
            unrealizedMultiple: 12,
            totalMultiple: 15,
            entryProgress: 0.05,
            early: true,
            profitState: 'complete',
            confidence: 'high'
          },
          {
            address: walletB,
            holderRank: 1,
            holdingValueUsd: 50_000,
            buyVolumeUsd: 499.99,
            totalMultiple: 100,
            early: true,
            profitState: 'complete'
          },
          {
            address: tokenC,
            holderRank: null,
            buyVolumeUsd: 10_000,
            totalMultiple: 100,
            early: true,
            profitState: 'failed'
          }
        ]
      }
    }],
    actionsByToken: new Map([[tokenA, [
      action({ token: tokenA, wallet: walletB, side: 'buy', amount: 100, quote: 1_000, price: 10, block: 1 })
    ]]]),
    minimumEntryUsd: 500,
    minimumHitMultiple: 10
  });

  assert.deepEqual(summaries.map((summary) => summary.address), [walletA]);
  assert.equal(summaries[0].winnerHits, 1);
  assert.equal(summaries[0].bestHolderRank, 2);
  assert.equal(summaries[0].totalHoldingValueUsd, 5_000);
  assert.equal(summaries[0].maxRealizedMultiple, 20);
  assert.equal(summaries[0].maxUnrealizedMultiple, 12);
  assert.equal(summaries[0].maxTotalMultiple, 15);
  assert.equal(summaries[0].candidateSource, 'top_holder');
  assert.deepEqual(summaries[0].performances[0].actions, []);
});

test('does not admit a rounded display amount that was below the raw entry floor', () => {
  const summaries = buildWalletSummaries({
    tokens: [{
      address: tokenA,
      symbol: 'BOUNDARY',
      manual: true,
      holderAnalysis: {
        strategy: 'holder_first',
        minimumEntryUsd: 500,
        candidates: [{
          address: walletA,
          rawBuyVolumeUsd: 499.999,
          buyVolumeUsd: 500,
          entryCostUsd: 500,
          eligible: false,
          totalMultiple: 100,
          early: true,
          profitState: 'complete'
        }]
      }
    }],
    minimumEntryUsd: 500,
    minimumHitMultiple: 10
  });

  assert.deepEqual(summaries, []);
});

test('recalculates cached external-inflow candidates instead of trusting gross sale multiples', () => {
  const [summary] = buildWalletSummaries({
    tokens: [{
      address: tokenA,
      symbol: 'TRANSFERRED',
      manual: true,
      peakMarketCapUsd: 229_300_000,
      holderAnalysis: {
        strategy: 'holder_first',
        minimumEntryUsd: 1_000,
        candidates: [{
          address: walletA,
          holderRank: 101,
          holdingTokenAmount: 0,
          holdingValueUsd: 0,
          holdingSharePercent: 0.175646,
          buyAmount: 122_505.97366,
          sellAmount: 3_961_206.45457,
          buyVolumeUsd: 2_446.652340149915,
          sellVolumeUsd: 286_112.92936865165,
          buyTimes: 2,
          sellTimes: 23,
          profitRate: 0.7891220783282198,
          realizedProfitUsd: 1_931.036807078361,
          unrealizedProfitUsd: 0,
          totalProfitUsd: 1_931.036807078361,
          realizedMultiple: 1.0068,
          totalMultiple: 116.9406,
          entryProgress: 0.0871,
          early: true,
          profitState: 'complete',
          confidence: 'high'
        }]
      }
    }],
    minimumEntryUsd: 500,
    smartBaseMultiple: 5,
    strictMultiple: 10,
    significantProfitRate: 0.002
  });

  const [performance] = summary.performances;
  assert.equal(performance.costBasisStatus, 'incomplete_external_inflow');
  assert.equal(performance.costBasisComplete, false);
  assert.equal(performance.totalMultiple, 1.7891);
  assert.equal(performance.bestMultiple, 1.7891);
  assert.equal(performance.smartEligible, false);
  assert.equal(summary.maxTotalMultiple, 1.7891);
  assert.equal(summary.winnerHits, 0);
  assert.equal(summary.smartEligible, false);
});

test('counts distinct manual winners from buy quantity, cost, and historical peak price', () => {
  const candidate = ({ address = walletA, buyAmount = 100, buyVolumeUsd = 200, averageBuyPriceUsd = 2 } = {}) => ({
    address,
    holderRank: 25,
    buyAmount,
    sellAmount: 0,
    holdingTokenAmount: buyAmount,
    holdingValueUsd: 50,
    buyVolumeUsd,
    averageBuyPriceUsd,
    currentPriceUsd: 0.5,
    totalProfitUsd: -150,
    realizedProfitUsd: 0,
    unrealizedProfitUsd: -150,
    totalMultiple: 0.25,
    profitState: 'complete',
    confidence: 'high'
  });
  const [summary] = buildWalletSummaries({
    tokens: [
      {
        address: tokenA,
        symbol: 'FELL',
        manual: true,
        peakPriceUsd: 10,
        peakMarketCapUsd: 10_000_000,
        holderAnalysis: {
          strategy: 'holder_first',
          minimumEntryUsd: 100,
          candidates: [candidate(), candidate()]
        }
      },
      {
        address: tokenB,
        symbol: 'THREE_X',
        manual: true,
        peakPriceUsd: 12,
        peakMarketCapUsd: 12_000_000,
        holderAnalysis: {
          strategy: 'holder_first',
          minimumEntryUsd: 100,
          candidates: [candidate({ buyAmount: 50, buyVolumeUsd: 200, averageBuyPriceUsd: 4 })]
        }
      },
      {
        address: tokenC,
        symbol: 'NOT_MANUAL',
        qualified: true,
        peakPriceUsd: 100,
        peakMarketCapUsd: 100_000_000,
        holderAnalysis: {
          strategy: 'holder_first',
          minimumEntryUsd: 100,
          candidates: [candidate()]
        }
      }
    ],
    minimumEntryUsd: 100,
    smartBaseMultiple: 5,
    strictMultiple: 10
  });

  const fell = summary.performances.find((performance) => performance.tokenAddress === tokenA);
  assert.equal(fell.historicalPeakGrossValueUsd, 1_000);
  assert.equal(fell.historicalPeakProfitUsd, 800);
  assert.equal(fell.historicalPeakMultiple, 5);
  assert.equal(fell.historicalPeakReturnRate, 4);
  assert.equal(fell.historicalPeakReturnPercent, 400);
  assert.equal(fell.manualWinnerHit, true);
  assert.equal(summary.winnerHits, 0);
  assert.equal(summary.manualWinnerParticipationCount, 2);
  assert.equal(summary.manualTokenParticipationCount, 2);
  assert.equal(summary.manualWinnerHitCount, 1);
  assert.equal(summary.manualWinnerHitRate, 0.5);
  assert.equal(summary.manualWinnerHitThreshold, 5);
  assert.deepEqual(summary.manualWinnerHitTokenAddresses, [tokenA]);
  assert.equal(summary.maxHistoricalPeakMultiple, 50);
});

test('uses each Holder scan saved entry floor instead of reapplying the global default', () => {
  const candidate = (address, buyVolumeUsd) => ({
    address,
    holderRank: 5,
    holdingTokenAmount: 100,
    holdingValueUsd: 1_000,
    buyVolumeUsd,
    totalProfitUsd: 100,
    totalMultiple: 2,
    entryProgress: 0.1,
    early: true,
    profitState: 'complete'
  });
  const summaries = buildWalletSummaries({
    tokens: [
      {
        address: tokenA,
        symbol: 'LOWER',
        manual: true,
        holderAnalysis: {
          strategy: 'holder_first',
          minimumEntryUsd: 250,
          candidates: [candidate(walletA, 300), candidate(walletB, 200)]
        }
      },
      {
        address: tokenB,
        symbol: 'HIGHER',
        manual: true,
        holderAnalysis: {
          strategy: 'holder_first',
          minimumEntryUsd: 800,
          candidates: [candidate(walletA, 700), candidate(walletB, 900)]
        }
      }
    ],
    minimumEntryUsd: 500,
    minimumHitMultiple: 10
  });
  const byAddress = new Map(summaries.map((summary) => [summary.address, summary]));

  assert.deepEqual(byAddress.get(walletA).performances.map((row) => row.tokenAddress), [tokenA]);
  assert.equal(byAddress.get(walletA).minimumEntryUsd, 250);
  assert.equal(byAddress.get(walletA).performances[0].minimumEntryUsd, 250);
  assert.deepEqual(byAddress.get(walletB).performances.map((row) => row.tokenAddress), [tokenB]);
  assert.equal(byAddress.get(walletB).minimumEntryUsd, 800);
});

test('does not fall back to legacy pool actions when a holder-first snapshot has no candidates', () => {
  const summaries = buildWalletSummaries({
    tokens: [{
      address: tokenA,
      symbol: 'EMPTY',
      manual: true,
      quoteUsd: 1,
      holderAnalysis: { strategy: 'holder_first', complete: true, candidates: [] }
    }],
    actionsByToken: new Map([[tokenA, [
      action({ token: tokenA, wallet: walletA, side: 'buy', amount: 100, quote: 1_000, price: 0.01, block: 1 }),
      action({ token: tokenA, wallet: walletB, side: 'buy', amount: 10, quote: 100, price: 0.02, block: 2 }),
      action({ token: tokenA, wallet: walletA, side: 'sell', amount: 50, quote: 5_000, price: 1, block: 3 })
    ]]]),
    minimumEntryUsd: 500,
    minimumHitMultiple: 10
  });

  assert.deepEqual(summaries, []);
});

test('admits 5x to 10x wallets by peak-market-cap-relative profit instead of fixed dollars', () => {
  const candidate = ({
    address,
    totalProfitUsd,
    realizedProfitUsd = 0,
    holdingValueUsd = 10_000,
    holderRank = 5,
    totalMultiple = 7
  }) => ({
    address,
    holderRank,
    holdingTokenAmount: holdingValueUsd,
    holdingValueUsd,
    holdingSharePercent: 0,
    buyVolumeUsd: 600,
    realizedProfitUsd,
    unrealizedProfitUsd: totalProfitUsd - realizedProfitUsd,
    totalProfitUsd,
    totalMultiple,
    entryProgress: 0.05,
    early: true,
    profitState: 'complete',
    confidence: 'high'
  });
  const summaries = buildWalletSummaries({
    tokens: [{
      address: tokenA,
      symbol: 'DYNAMIC',
      manual: true,
      peakMarketCapUsd: 1_000_000,
      holderAnalysis: {
        strategy: 'holder_first',
        complete: true,
        candidates: [
          candidate({ address: walletA, totalProfitUsd: 2_000 }),
          candidate({ address: walletB, totalProfitUsd: 1_999 }),
          candidate({
            address: walletC,
            totalProfitUsd: 2_500,
            realizedProfitUsd: 2_500,
            holdingValueUsd: 0,
            holderRank: 100
          }),
          candidate({ address: walletD, totalProfitUsd: 100, totalMultiple: 12, holderRank: 100 })
        ]
      }
    }],
    minimumEntryUsd: 500,
    smartBaseMultiple: 5,
    strictMultiple: 10,
    significantProfitRate: 0.002
  });
  const byAddress = new Map(summaries.map((summary) => [summary.address, summary]));

  assert.equal(byAddress.get(walletA).smartEligible, true);
  assert.deepEqual(byAddress.get(walletA).smartReasons, ['heavy_5x']);
  assert.equal(byAddress.get(walletA).performances[0].significantProfitUsd, 2_000);
  assert.equal(byAddress.get(walletA).performances[0].profitToPeakMarketCapRatio, 0.002);
  assert.equal(byAddress.get(walletB).smartEligible, false);
  assert.equal(byAddress.get(walletC).smartEligible, true);
  assert.deepEqual(byAddress.get(walletC).smartReasons, ['realized_5x']);
  assert.equal(byAddress.get(walletD).smartEligible, true);
  assert.deepEqual(byAddress.get(walletD).smartReasons, ['high_multiple']);
});

test('does not admit a one-off 10x wallet without meaningful profit or holding value', () => {
  const [summary] = buildWalletSummaries({
    tokens: [{
      address: tokenA,
      symbol: 'TINY',
      manual: true,
      peakMarketCapUsd: 1_000_000,
      holderAnalysis: {
        strategy: 'holder_first',
        complete: true,
        candidates: [{
          address: walletA,
          holderRank: 100,
          holdingTokenAmount: 0,
          holdingValueUsd: 0,
          holdingSharePercent: 0,
          buyAmount: 100,
          sellAmount: 100,
          buyVolumeUsd: 600,
          totalProfitUsd: 100,
          totalMultiple: 12,
          entryProgress: 0.05,
          early: true,
          profitState: 'complete',
          confidence: 'high'
        }]
      }
    }],
    minimumEntryUsd: 500,
    smartBaseMultiple: 5,
    strictMultiple: 10,
    significantProfitRate: 0.002
  });

  const [performance] = summary.performances;
  assert.equal(performance.hit, true);
  assert.equal(performance.smartEligible, false);
  assert.equal(performance.smartAdmissionChecks.valueEvidence, false);
  assert.equal(summary.smartEligible, false);
  assert.deepEqual(summary.smartReasons, []);
});

test('does not replace a missing peak market cap with a fixed USD profit threshold', () => {
  const summaries = buildWalletSummaries({
    tokens: [{
      address: tokenA,
      symbol: 'NOPEAK',
      manual: true,
      holderAnalysis: {
        strategy: 'holder_first',
        complete: true,
        candidates: [{
          address: walletA,
          holderRank: 1,
          holdingTokenAmount: 1_000_000,
          holdingValueUsd: 1_000_000,
          buyVolumeUsd: 10_000,
          unrealizedProfitUsd: 990_000,
          totalProfitUsd: 990_000,
          totalMultiple: 7,
          entryProgress: 0.05,
          early: true,
          profitState: 'complete'
        }]
      }
    }],
    minimumEntryUsd: 500,
    smartBaseMultiple: 5,
    strictMultiple: 10,
    significantProfitRate: 0.002
  });
  const [summary] = summaries;

  assert.equal(summary.winnerHits, 1);
  assert.equal(summary.smartEligible, false);
  assert.equal(summary.performances[0].smartAdmissionChecks.peakMarketCapAvailable, false);
  assert.equal(summary.performances[0].significantProfitUsd, null);
});

test('keeps a provisional peak market cap pending instead of admitting a relative-profit 5x wallet', () => {
  const summaries = buildWalletSummaries({
    tokens: [{
      address: tokenA,
      symbol: 'PROVISIONAL',
      manual: true,
      peakMarketCapUsd: 1_000_000,
      peakMarketCapProvisional: true,
      peakMarketCapSource: 'debot_current_snapshot_fallback',
      holderAnalysis: {
        strategy: 'holder_first',
        complete: true,
        candidates: [{
          address: walletA,
          holderRank: 2,
          holdingTokenAmount: 10_000,
          holdingValueUsd: 10_000,
          buyVolumeUsd: 600,
          unrealizedProfitUsd: 3_000,
          totalProfitUsd: 3_000,
          totalMultiple: 6,
          entryProgress: 0.05,
          early: true,
          profitState: 'complete'
        }]
      }
    }],
    minimumEntryUsd: 500,
    smartBaseMultiple: 5,
    strictMultiple: 10,
    significantProfitRate: 0.002
  });
  const [summary] = summaries;
  const [performance] = summary.performances;

  assert.equal(summary.smartEligible, false);
  assert.equal(summary.smartPending, true);
  assert.deepEqual(summary.smartPendingReasons, ['peak_market_cap_provisional']);
  assert.equal(performance.relativeProfitMeetsThreshold, true);
  assert.equal(performance.significantProfit, false);
  assert.equal(performance.smartAdmissionChecks.peakMarketCapReliable, false);
});

test('promotes repeat 5x hits even when neither token has peak-market-cap admission data', () => {
  const holderToken = (address, candidates) => ({
    address,
    symbol: 'REPEAT',
    manual: true,
    holderAnalysis: { strategy: 'holder_first', complete: true, candidates }
  });
  const candidate = (address, firstTradeAt) => ({
    address,
    holderRank: 40,
    holdingTokenAmount: 5_000,
    holdingValueUsd: 5_000,
    buyVolumeUsd: 700,
    buyTimes: 2,
    sellTimes: 1,
    totalProfitUsd: 4_300,
    totalMultiple: 6,
    entryProgress: 0.05,
    early: true,
    firstTradeAt,
    firstFunding: { from: walletD, tx_hash: `0x${String(firstTradeAt).padStart(64, '0')}` },
    profitState: 'complete'
  });
  const summaries = buildWalletSummaries({
    tokens: [
      holderToken(tokenA, [candidate(walletA, 120), candidate(walletB, 180)]),
      holderToken(tokenB, [candidate(walletA, 240)])
    ],
    minimumEntryUsd: 500,
    smartBaseMultiple: 5,
    strictMultiple: 10,
    repeatMinHits: 2
  });
  const byAddress = new Map(summaries.map((summary) => [summary.address, summary]));
  const repeated = byAddress.get(walletA);

  assert.equal(repeated.winnerHits, 2);
  assert.equal(repeated.smartEligible, true);
  assert.deepEqual(repeated.smartReasons, ['repeat_5x', 'low_frequency']);
  assert.equal(repeated.observedWinRate, 1);
  assert.equal(repeated.adjustedWinRate, 0.75);
  assert.equal(repeated.sampleConfidence, 0.5);
  assert.equal(repeated.totalTradeCount, 6);
  assert.equal(repeated.tradeFrequency, 3);
  assert.equal(repeated.clusterFingerprints.length, 2);
  assert.equal(repeated.clusterEvidence[0].firstFundingSource, walletD);
  assert.equal(byAddress.get(walletB).smartEligible, false);
});

test('marks only strongly evidenced related wallets and applies a modest score penalty', () => {
  const sharedFundingTx = `0x${'9'.repeat(64)}`;
  const candidate = (address, fundingTx, firstTradeAt = 120) => ({
    address,
    holderRank: 4,
    holdingTokenAmount: 20_000,
    holdingValueUsd: 20_000,
    buyVolumeUsd: 1_000,
    buyTimes: 2,
    sellTimes: 1,
    totalProfitUsd: 19_000,
    totalMultiple: 20,
    entryProgress: 0.05,
    early: true,
    firstTradeAt,
    firstFunding: { from: walletD, tx_hash: fundingTx },
    profitState: 'complete'
  });
  const summaries = buildWalletSummaries({
    tokens: [{
      address: tokenA,
      symbol: 'CLUSTER',
      manual: true,
      peakMarketCapUsd: 1_000_000,
      holderAnalysis: {
        strategy: 'holder_first',
        complete: true,
        candidates: [
          candidate(walletA, sharedFundingTx),
          candidate(walletB, sharedFundingTx),
          candidate(walletC, `0x${'8'.repeat(64)}`, 300)
        ]
      }
    }],
    minimumEntryUsd: 500,
    smartBaseMultiple: 5,
    strictMultiple: 10,
    relatedClusterPenalty: 0.9
  });
  const byAddress = new Map(summaries.map((summary) => [summary.address, summary]));
  const related = byAddress.get(walletA);
  const independent = byAddress.get(walletC);

  assert.equal(related.relatedCluster.type, 'shared_funding_transaction');
  assert.deepEqual(related.relatedCluster.peers, [walletB]);
  assert.equal(related.relatedCluster.confidence, 'high');
  assert.equal(related.relatedCluster.scoreMultiplier, 0.9);
  assert.equal(related.smartReasons.includes('related_cluster'), true);
  assert.equal(related.clusterScorePenalty, 0.9);
  assert.equal(related.smartScore, Math.round(related.preClusterSmartScore * 0.9 * 10) / 10);
  assert.equal(related.clusterPenaltyPoints > 0, true);
  assert.equal(independent.relatedCluster, null);
  assert.equal(independent.clusterScorePenalty, 1);
  assert.equal(independent.smartScore, independent.preClusterSmartScore);
});
