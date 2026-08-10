import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const indexHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const telegramMonitorJs = fs.readFileSync(new URL('../public/telegram-monitor.js', import.meta.url), 'utf8');
const telegramSocialJs = fs.readFileSync(new URL('../public/telegram-social.js', import.meta.url), 'utf8');
const feishuMonitorJs = fs.readFileSync(new URL('../public/feishu-monitor.js', import.meta.url), 'utf8');
const telegramViewerJs = fs.readFileSync(new URL('../telegram/web/app.js', import.meta.url), 'utf8');
const stylesCss = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

function appSourceBetween(start, end) {
  const startIndex = appJs.indexOf(start);
  const endIndex = appJs.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing app source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing app source marker: ${end}`);
  return appJs.slice(startIndex, endIndex);
}

function executableSocialReferenceMarkup() {
  const source = `
    ${appSourceBetween('function escapeHtml(value)', 'function finiteNumber(')}
    const SOCIAL_HANDLE_PATTERN = /^[a-z0-9_]{1,15}$/i;
    ${appSourceBetween('function normalizeSocialHandle(value)', 'function decodeSocialActivityExternalId(')}
    ${appSourceBetween('function mergeSocialMediaItems(current, incoming)', 'function flushDeferredSocialPosts()')}
    ${appSourceBetween('function socialXStatusIdentity(value)', 'function visibleSocialPosts(')}
    return socialReferenceMarkup;
  `;
  return Function(source)();
}

function executableSocialMediaMarkup() {
  const source = `
    ${appSourceBetween('function escapeHtml(value)', 'function finiteNumber(')}
    ${appSourceBetween('function mergeSocialMediaItems(current, incoming)', 'function flushDeferredSocialPosts()')}
    ${appSourceBetween('function socialMediaMarkup(media,', 'function socialReplyMarkup(post)')}
    return socialMediaMarkup;
  `;
  return Function(source)();
}

function executableVisibleSocialPosts({ posts, query, notesByPostId }) {
  const source = appSourceBetween('function visibleSocialPosts()', 'function renderSocialBridgeStatus()');
  const translationSource = appSourceBetween(
    'function isChineseMajoritySocialText(value)',
    'function socialReplyMarkup(post)'
  );
  return Function(
    'state',
    'isEnabledPersonalSocialEvent',
    'socialActivityIdentity',
    'socialWatchEntryForPost',
    `${translationSource}\n${source}\nreturn visibleSocialPosts();`
  )(
    { socialPosts: posts, socialSearchQuery: query },
    () => true,
    () => null,
    (post) => ({ note: notesByPostId[post.id] || '' })
  );
}

function executableSocialTranslationHelpers(source = appJs) {
  const startIndex = source.indexOf('function isChineseMajoritySocialText(value)');
  const endMarker = source === appJs ? 'function socialReplyMarkup(post)' : 'function payloadVersion(payload)';
  const endIndex = source.indexOf(endMarker, startIndex);
  assert.notEqual(startIndex, -1, 'missing Chinese-majority helper');
  assert.notEqual(endIndex, -1, `missing helper end marker: ${endMarker}`);
  const helperSource = source.slice(startIndex, endIndex);
  const returnName = source === appJs ? 'socialTranslationForDisplay' : 'translationForDisplay';
  return Function(
    `${helperSource}\nreturn { isChineseMajoritySocialText, translationForDisplay: ${returnName} };`
  )();
}

function executableSocialLatencyMarkup() {
  const source = appSourceBetween('function formatSocialLatencyMs(start, end)', 'function socialActivityMarkup(post)');
  return Function(
    'monitorTimestampMs',
    'escapeHtml',
    `${source}\nreturn socialLatencyMarkup;`
  )(
    (value) => Number.isFinite(Number(value)) ? Number(value) : null,
    (value) => String(value)
  );
}

function executableSortSocialWatchlistByAdded() {
  const source = appSourceBetween('function sortSocialWatchlistByAdded(entries)', 'function applySocialBridgeStatus(bridge)');
  return Function(`${source}\nreturn sortSocialWatchlistByAdded;`)();
}

function executableGeneratedWalletProfitPosition() {
  const source = appSourceBetween(
    'function generatedWalletProfitPosition(alias, aliasSource)',
    'function monitorEventTimestamp(event)'
  );
  return Function(`${source}\nreturn generatedWalletProfitPosition;`)();
}

function executableRenderMonitorTokenRisk(chainId = 'robinhood') {
  const source = `
    ${appSourceBetween('function escapeHtml(value)', 'function safeHttpUrl(value)')}
    ${appSourceBetween('function finiteNumber(...values)', 'function firstValue(source, keys, fallback = null)')}
    ${appSourceBetween('function normalizedMonitorRiskPercent(value)', 'function monitorPlatformLabel(value)')}
    return renderMonitorTokenRisk;
  `;
  return Function(
    'monitorChainId',
    'formatMoney',
    'formatDateTime',
    'MONITOR_TOKEN_RISK_STATUSES',
    source
  )(
    (value) => String(value || chainId),
    (value) => `$${Number(value) / 1_000}K`,
    (value) => String(value),
    new Set(['pending', 'partial', 'ready', 'unavailable', 'error'])
  );
}

test('home is the manual Robinhood smart-money workspace', () => {
  assert.match(indexHtml, /<title>1874catch<\/title>/);
  assert.match(indexHtml, /<link rel="icon" href="assets\/ikun-chick\.png" type="image\/png" \/>/);
  assert.match(indexHtml, /<link rel="apple-touch-icon" href="assets\/ikun-chick\.png" \/>/);
  assert.match(indexHtml, /<h1 id="brand-title">1874catch<\/h1>/);
  assert.match(indexHtml, /<img src="assets\/ikun-chick\.png" width="44" height="44" alt="" \/>/);
  assert.match(indexHtml, /Robinhood · 手工金狗、最近重扫候选与已确认地址库/);
  assert.match(appJs, /const SITE_NAME = '1874catch'/);
  assert.match(appJs, /document\.title = SITE_NAME/);
  assert.match(appJs, /elements\.brandTitle\.textContent = SITE_NAME/);
  assert.doesNotMatch(appJs, /elements\.chainMark|chain\.mark/);
  assert.match(indexHtml, /<dt>手工金狗<\/dt>/);
  assert.match(indexHtml, /id="results-container"/);
  assert.match(indexHtml, /id="detail-panel"/);
});

test('wallet library views and the manual gold-dog queue are first-level tabs', () => {
  for (const [tab, label] of [
    ['candidates', '最近重扫候选'],
    ['all_round', '已确认地址库'],
    ['winners', '金狗队列']
  ]) {
    assert.match(indexHtml, new RegExp(`data-tab="${tab}"[^>]*>${label}<`));
  }
  for (const [tab, label] of [['realized', '兑现候选'], ['unrealized', '持仓候选'], ['single_hit', '单次候选']]) {
    assert.doesNotMatch(indexHtml, new RegExp(`data-tab="${tab}"[^>]*>${label}<`));
  }
  assert.match(indexHtml, /class="tab-button is-active"[^>]*data-tab="monitor"[^>]*aria-selected="true"/);
  assert.match(indexHtml, /data-tab="candidates"[^>]*aria-selected="false"/);
});

test('wallet analysis exposes an editable per-scan minimum entry floor', () => {
  assert.match(indexHtml, /id="min-entry-summary">\$500 起</);
  assert.match(indexHtml, /id="min-hits"[^>]*min="0"[^>]*value="1"/);
  assert.match(indexHtml, /单币最低买入 \(\$\)[\s\S]*id="min-entry-input"[^>]*name="minEntryUsd"[^>]*min="0"[^>]*max="1000000000"[^>]*value="500"/);
  assert.doesNotMatch(indexHtml, /max-entries|最多出手/);
  for (const multiple of [5, 10, 50, 100]) {
    assert.match(indexHtml, new RegExp(`data-multiple="${multiple}"`));
  }
  const smartButton = indexHtml.indexOf('data-strategy="smart"');
  const firstMultiple = indexHtml.indexOf('data-multiple="5"');
  assert.ok(smartButton >= 0 && smartButton < firstMultiple);
  assert.match(indexHtml, /class="is-active"[^>]*data-strategy="smart"[^>]*aria-pressed="true"[^>]*>智能</);
  assert.match(indexHtml, /id="profit-mode"/);
  assert.match(indexHtml, /id="confidence"/);
  assert.match(indexHtml, /id="exclude-noise"[^>]*checked/);
  assert.doesNotMatch(indexHtml, /id="(?:analysis-window|min-liquidity|min-wallets|max-entries)"/);
  assert.match(appJs, /minEntryUsd: currentMinimumEntryUsd\(\)/);
  assert.match(appJs, /minEntryUsd: String\(filters\.minEntryUsd\)/);
  assert.match(appJs, /单币买入 ≥/);
});

test('smart strategy is the default while every request keeps the 10x compatibility fallback', () => {
  assert.match(appJs, /activeTab: 'monitor',\s+strategy: 'smart',\s+multiple: 10/);
  assert.match(appJs, /strategy: state\.strategy,\s+multiple: state\.multiple/);
  assert.match(appJs, /strategy: filters\.strategy,\s+multiple: String\(filters\.multiple\)/);
  assert.match(appJs, /const body = JSON\.stringify\(\{ \.\.\.filters, classification:/);
  assert.match(appJs, /fetchChainJson\(context, '\/refresh', \{ method: 'POST', body \}\)/);
  assert.match(appJs, /if \(button\.dataset\.strategy === 'smart'\) \{\s+state\.strategy = 'smart';\s+state\.multiple = 10/);
  assert.match(appJs, /else \{\s+state\.strategy = 'multiple';\s+state\.multiple = Number\(button\.dataset\.multiple\)/);
  assert.match(appJs, /closest\('\[data-strategy\], \[data-multiple\]'\)/);
  assert.match(appJs, /filters\.strategy === 'smart' \? '智能策略' : `\$\{filters\.multiple\}x 起`/);
  assert.match(stylesCss, /grid-template-columns: repeat\(5, minmax\(44px, 1fr\)\)/);
});

test('manual CA dock is always visible and supports validated batches of up to 20', () => {
  const formTag = indexHtml.match(/<form class="manual-token-form" id="manual-token-form"[^>]*>/)?.[0];
  assert.ok(formTag);
  assert.doesNotMatch(formTag, /\bhidden\b/);
  assert.match(indexHtml, /<textarea[\s\S]*id="manual-token-address"/);
  assert.match(appJs, /addressPattern: \/\^0x\[0-9a-fA-F\]\{40\}\$\//);
  assert.match(appJs, /ADDRESS_PATTERN = chain\.addressPattern/);
  assert.match(appJs, /manualInput\.value\.split\(\/\[\\s,;，；\]\+\//);
  assert.match(appJs, /new Set\(parts\.map\(normalizeAddress\)\.filter\(Boolean\)\)/);
  assert.match(appJs, /addresses\.length > 20/);
  assert.match(appJs, /Promise\.allSettled\(addresses\.map/);
  assert.match(appJs, /body: JSON\.stringify\(\{ address, minEntryUsd \}\)/);
});

test('manual CA submissions stay visible from queue through terminal analysis status', () => {
  for (const field of [
    'manualWinnerPollTimer: null',
    'manualWinnerPollBusy: false',
    'manualWinnerTracking: null',
    'manualWinnerTrackingSequence: 0'
  ]) {
    assert.equal(appJs.includes(field), true, `missing manual winner tracking state: ${field}`);
  }
  assert.match(appJs, /function beginManualWinnerTracking\(context, records/);
  assert.match(appJs, /setManualWinnerFeedback\(parts\.join\(' · '\), snapshot\.failed\.length \? 'error' : ''\)/);
  assert.match(appJs, /`排队中 \$\{queued\} 个`/);
  assert.match(appJs, /`正在分析 \$\{analyzing\} 个`/);
  assert.match(appJs, /pipelineSummary\(counts\)/);
  assert.match(appJs, /`分析完成 \$\{snapshot\.complete\.length\} 个/);
  assert.match(appJs, /manualWinnerJobError\(record\)/);
  assert.match(appJs, /fetchChainJson\(tracking\.context, '\/jobs'\)/);
  assert.match(appJs, /if \(state\.manualWinnerPollBusy \|\| state\.loading\)/);
  assert.match(appJs, /state\.manualWinnerPollTimer = setTimeout\(\(\) => void pollManualWinnerJobs\(sequence\), delay\)/);
  assert.doesNotMatch(appJs, /setInterval\(\(\) => void pollManualWinnerJobs/);
  assert.match(appJs, /if \(state\.manualWinnerTracking\?\.sequence !== sequence\) return/);
  assert.match(appJs, /if \(state\.manualWinnerTracking\) return;\s+if \(statusFromData\(data\) === 'scanning'\)/);
});

test('the interface only presents user-submitted tokens and holder-profit progress', () => {
  for (const forbidden of ['自动发现', '预筛达标', '链上达标', '历史样本', '样本判定']) {
    assert.equal(indexHtml.includes(forbidden) || appJs.includes(forbidden), false, `unexpected discovery copy: ${forbidden}`);
  }
  assert.match(appJs, /自动分析结果先进入待审核候选，确认后才进入地址库/);
  assert.match(appJs, /label: '(?:Holder 分析完成|扫描完成)'/);
  assert.match(appJs, /label: '待扫描'/);
  assert.match(appJs, /<h3>扫描记录<\/h3>/);
  assert.match(appJs, /data\.winners\.filter\(\(winner\) => winner\.manual === true\)\.length/);
});

test('holder-first queue reports fetched, analyzed, eligible and configured-floor filtered counts', () => {
  for (const field of ['fetched', 'analyzed', 'eligible', 'filtered']) {
    assert.match(appJs, new RegExp(`${field}: from\\(`));
  }
  for (const copy of ['已抓取', '已核算', '可入库', '低于门槛已过滤', '抓取持仓候选', '核算地址收益']) {
    assert.equal(appJs.includes(copy), true, `missing holder pipeline copy: ${copy}`);
  }
  assert.match(appJs, /winnerPipelineCounts\(winner\)/);
  assert.match(appJs, /matchingWinnerJob\(winner\)/);
  assert.match(appJs, /pipelineSummary\(pipeline\)/);
});

test('onchain fallback scans are labeled separately from Holder-first analysis', () => {
  assert.match(appJs, /function winnerUsesOnchainFallback\(winner\)/);
  assert.match(appJs, /\(onchain\|robinhood_rpc\)/i);
  assert.match(appJs, /label: '正在扫描链上交易'/);
  assert.match(appJs, /label: '链上扫描完成'/);
  assert.match(appJs, /链上交易扫描完成/);
  assert.match(appJs, /链上 Holder 部分分析/);
  assert.match(appJs, /仅当 Blockscout 当前持仓能与已观察买卖对账时才计算收益/);
  assert.match(appJs, /未观察到的转账、外部转入和未观察池活动不会入库/);
  assert.match(appJs, /未能对账/);
});

test('failed refreshes keep usable Holder snapshots visibly distinct from hard failures', () => {
  assert.match(appJs, /function winnerHasStaleHolderCache\(winner\)/);
  assert.match(appJs, /function winnerJobIsActive\(winner\)/);
  assert.match(appJs, /winnerHasStaleHolderCache\(winner\) && !winnerJobIsActive\(winner\)\) return snapshot/);
  assert.match(appJs, /if \(winnerJobIsActive\(winner\)\) return pipelineStage\(job\) \|\| pipelineStage\(winner\)/);
  assert.match(appJs, /if \(winnerHasStaleHolderCache\(winner\)\) return 'stale'/);
  assert.match(appJs, /label: '旧结果可用 · 重扫失败'/);
  assert.match(appJs, /正在显示上次有效 Holder 结果/);
  assert.match(appJs, /有效快照/);
  assert.match(appJs, /最新重扫失败/);
  assert.match(appJs, /winnerStaleHolderError\(winner\)/);
  assert.match(appJs, /staleHolderCache \? '缓存快照' : '手工提交'/);
});

test('cached terminal scans remain reviewable and submission feedback reports the retained result', () => {
  assert.match(appJs, /return status === 'complete' \|\| job\?\.cachedResult === true/);
  assert.match(appJs, /'completedAt', 'failedAt', 'finishedAt', 'updatedAt'/);
  assert.match(appJs, /job\?\.cachedResult === true && \['failed', 'error', 'complete', 'completed', 'partial'\]\.includes\(status\)/);
  assert.match(appJs, /return 'cached'/);
  assert.match(appJs, /`重扫失败但保留旧结果 \$\{snapshot\.cached\.length\} 个`/);
  assert.match(appJs, /`保留旧结果 \$\{snapshot\.cached\.length\}\/\$\{total\}`/);
});

test('gold-dog queue hides wallet filters and restores them for wallet tabs', () => {
  assert.match(appJs, /function syncToolbarVisibility\(\)/);
  assert.match(appJs, /const showingWinnerQueue = state\.activeTab === 'winners'/);
  assert.match(appJs, /elements\.filterForm\.hidden = showingMonitor \|\| showingWinnerQueue/);
  assert.match(appJs, /elements\.libraryForm\.hidden = showingMonitor \|\| showingWinnerQueue/);
  assert.match(appJs, /state\.activeTab = button\.dataset\.tab;\s+state\.selectedCandidates\.clear\(\);\s+syncToolbarVisibility\(\)/);
  assert.match(appJs, /state\.detailAddress !== normalizeAddress\(selected\.address\)/);
  assert.match(appJs, /renderWinnerDetail\(selected\)/);
  assert.match(appJs, /void loadWalletDetail\(selected/);
});

test('each gold-dog CA can repeat its Holder analysis from the queue or detail panel', () => {
  assert.match(appJs, /rescanningWinnerAddresses: new Set\(\)/);
  assert.match(appJs, /function winnerRescanActive\(winner\)/);
  assert.match(appJs, /function syncWinnerRescanButtons\(winner\)/);
  assert.match(appJs, /function syncWinnerRescanButtonsByAddress\(address\)/);
  assert.match(appJs, /document\.querySelectorAll\('\[data-rescan-winner\]'\)/);
  assert.match(appJs, /button\.classList\.toggle\('is-spinning', active\)/);
  assert.match(appJs, /if \(selected\) syncWinnerRescanButtons\(selected\)/);
  assert.match(appJs, /data-rescan-winner="\$\{escapeHtml\(address\)\}"/);
  assert.match(appJs, /aria-label="\$\{rescanning \? 'Holder 正在重新分析' : '重新分析这个 CA 的 Holder'\}"/);
  assert.match(appJs, /\/winners\/\$\{encodeURIComponent\(normalized\)\}\/rescan/);
  assert.match(appJs, /method: 'POST'/);
  assert.match(appJs, /body: JSON\.stringify\(\{ minEntryUsd \}\)/);
  assert.match(appJs, /result\.alreadyRunning \? '这个 CA 正在分析中' : 'Holder 重新分析已进入队列'/);
  assert.match(appJs, /state\.rescanningWinnerAddresses\.add\(normalized\);\s+syncWinnerRescanButtonsByAddress\(normalized\)/);
  assert.match(appJs, /state\.rescanningWinnerAddresses\.delete\(normalized\);\s+syncWinnerRescanButtonsByAddress\(normalized\)/);
  const rescanSource = appJs.slice(appJs.indexOf('async function rescanWinner'), appJs.indexOf('async function addManualWinner'));
  assert.doesNotMatch(rescanSource, /renderResults\(\)/);
  assert.match(appJs, /event\.target\.closest\('\[data-rescan-winner\]'\)/);
  assert.match(stylesCss, /\.inline-icon-button\.is-spinning svg/);
  assert.match(stylesCss, /\.rescan-winner-button:disabled/);
});

test('address library supports search, status, wallet group, tag filters and reset', () => {
  for (const id of ['library-filter-form', 'wallet-search', 'wallet-status', 'wallet-monitor-tier', 'wallet-tag', 'library-filter-clear']) {
    assert.match(indexHtml, new RegExp(`id="${id}"`));
  }
  for (const status of ['active', 'watch', 'excluded', 'all']) {
    assert.match(indexHtml, new RegExp(`<option value="${status}"`));
  }
  assert.match(indexHtml, /<option value="" selected>活跃 \+ 观察<\/option>/);
  assert.match(appJs, /state\.librarySearchTimer = setTimeout/);
  assert.match(appJs, /elements\.walletStatus\.addEventListener\('change'/);
  assert.match(appJs, /elements\.walletMonitorTier\.addEventListener\('change'/);
  assert.match(appJs, /elements\.walletTag\.addEventListener\('change'/);
  assert.match(appJs, /elements\.walletSearch\.value = ''/);
  assert.match(appJs, /elements\.walletStatus\.value = ''/);
  assert.match(appJs, /elements\.walletMonitorTier\.value = 'all'/);
  assert.match(appJs, /if \(filters\.status\) params\.set\('status', filters\.status\)/);
  assert.match(appJs, /if \(filters\.monitorTier && filters\.monitorTier !== 'all'\) params\.set\('monitorTier', filters\.monitorTier\)/);
  assert.match(appJs, /if \(filters\.status && filters\.status !== 'all'/);
  assert.match(appJs, /state\.activeTab === 'all_round' && filters\.monitorTier !== 'all'/);
});

test('confirmed address library accepts batch wallet lines with optional notes', () => {
  assert.match(indexHtml, /<form class="manual-wallet-form" id="manual-wallet-form" hidden novalidate>/);
  assert.match(indexHtml, /<textarea id="manual-wallet-lines"[^>]*name="lines"[^>]*placeholder="0x\.\.\.&#10;0x\.\.\.,备注"[^>]*required/);
  assert.match(indexHtml, /id="manual-wallet-feedback"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(indexHtml, /id="manual-wallet-add-button"[^>]*type="submit"[\s\S]*data-lucide="list-plus"[\s\S]*批量添加/);
  assert.match(appJs, /elements\.manualWalletForm\.hidden = !showingConfirmedLibrary/);
  assert.match(appJs, /const lines = elements\.manualWalletLines\.value/);
  assert.match(appJs, /fetchChainJson\(context, '\/wallets\/batch', \{[\s\S]*method: 'POST',[\s\S]*body: JSON\.stringify\(\{ lines \}\)/);
  assert.match(appJs, /\['created', 'restored', 'updated', 'duplicate', 'invalid'\]\.map/);
  assert.match(appJs, /record\.results\.filter\(\(item\)[\s\S]*=== 'invalid'/);
  assert.match(appJs, /class="manual-wallet-invalid-list"/);
  assert.match(appJs, /elements\.manualWalletLines\.value = ''/);
  assert.match(appJs, /await loadData\(\{ quiet: true \}\)/);
  assert.match(stylesCss, /\.manual-wallet-form \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(stylesCss, /@media \(max-width: 760px\)[\s\S]*\.manual-wallet-form \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
});

test('confirmed address library exports the exact DeBot wallet-import format', () => {
  assert.match(indexHtml, /id="debot-export-button"[^>]*hidden[\s\S]*导出到 DeBot/);
  assert.match(appJs, /debotWalletManagerUrl: 'https:\/\/debot\.ai\/track\?chain=robinhood&tab=manager'/);
  assert.match(appJs, /DEBOT_WALLET_MANAGER_URL = chain\.debotWalletManagerUrl/);
  assert.match(appJs, /review: 'confirmed',[\s\S]*status: 'all'/);
  assert.match(appJs, /if \(!walletIsConfirmed\(wallet\)\) continue/);
  assert.match(appJs, /alias \? `\$\{address\} \$\{alias\}` : address/);
  assert.match(appJs, /join\('\\n'\)/);
  assert.match(appJs, /copyText\(text\)/);
  assert.match(appJs, /if \(typeof document\.execCommand !== 'function'\) return false/);
  assert.match(appJs, /catch \{\s+return false;\s+\} finally \{\s+input\?\.remove\(\)/);
  assert.match(appJs, /link\.download = `\$\{chainId\}-debot-wallets\.txt`/);
  assert.match(appJs, /elements\.debotExportButton\.hidden = state\.activeTab !== 'all_round'/);
});

test('smart-eligible summaries require explicit review before entering the confirmed library', () => {
  assert.match(indexHtml, /id="candidate-count"/);
  assert.match(indexHtml, /id="candidate-actions"/);
  assert.match(indexHtml, /id="select-page-candidates"[^>]*type="checkbox"/);
  assert.match(indexHtml, /id="confirm-selected-button"[^>]*disabled/);
  assert.match(appJs, /function walletIsConfirmed\(wallet\) \{\s+return wallet\?\.curated === true && String\(wallet\.status \|\| 'active'\)\.toLowerCase\(\) !== 'excluded'/);
  assert.match(appJs, /function walletIsSmartEligible\(wallet\)/);
  assert.match(appJs, /if \(!walletIsSmartEligible\(wallet\)\) return false/);
  assert.match(appJs, /function filterWallets\(wallets, filters\) \{\s+return wallets\.filter\(\(wallet\) => \{\s+if \(!walletIsConfirmed\(wallet\) && !walletIsSmartEligible\(wallet\)\) return false/);
  assert.match(appJs, /if \(tab === 'all_round'\) return wallet\?\.curated === true/);
  assert.match(appJs, /if \(tab === 'candidates'\) return walletIsCandidate\(wallet\)/);
  assert.match(appJs, /if \(!wallet \|\| walletIsConfirmed\(wallet\) \|\| String\(wallet\.status \|\| 'active'\)\.toLowerCase\(\) === 'excluded'\) return false/);
  assert.match(appJs, /data-candidate-select="\$\{escapeHtml\(address\)\}"/);
  assert.match(indexHtml, /全选当前页/);
  assert.match(appJs, /二次确认：将选中的 \$\{selected\.length\} 个候选加入已确认地址库/);
  assert.match(appJs, /Promise\.allSettled\(selected\.map\(\(wallet\) => requestCandidateConfirmation\(context, wallet\)\)\)/);
});

test('candidate and confirmed wallet lists support checkbox batch deletion', () => {
  assert.match(indexHtml, /id="delete-selected-button"[^>]*disabled/);
  assert.match(indexHtml, /id="delete-selected-label">批量删除/);
  assert.match(appJs, /return isCandidateReviewTab\(tab\) \|\| tab === 'all_round'/);
  assert.match(appJs, /if \(tab === 'all_round'\) \{\s+return walletIsConfirmed\(wallet\) && String\(wallet\.status \|\| 'active'\)\.toLowerCase\(\) !== 'excluded'/);
  assert.match(appJs, /selectionMode \? ' wallet-selection-table' : ''/);
  assert.match(appJs, /elements\.confirmSelectedButton\.hidden = !isCandidateReviewTab\(\)/);
  assert.match(appJs, /elements\.deleteSelectedButton\.disabled = selectedCount === 0/);
  assert.match(appJs, /确认批量删除选中的 \$\{selected\.length\} 个候选/);
  assert.match(appJs, /确认从已确认地址库删除并禁用选中的 \$\{selected\.length\} 个地址/);
  assert.match(appJs, /Promise\.allSettled\(selected\.map\(\(wallet\) => \{/);
  assert.match(appJs, /const resource = candidateMode \? '\/wallet-candidates' : '\/wallets'/);
  assert.match(appJs, /fetchChainJson\(context, `\/wallet-candidates\/\$\{encodeURIComponent\(normalized\)\}`/);
  assert.match(appJs, /elements\.deleteSelectedButton\.addEventListener\('click', \(\) => void deleteSelectedWallets\(\)\)/);
  assert.match(stylesCss, /\.batch-delete-button \{/);
  assert.match(stylesCss, /\.wallet-selection-table \.candidate-select-cell/);
});

test('candidate rows support DeBot inspection, confirmation, exclusion and deterministic aliases', () => {
  assert.match(appJs, /debotAddressRoot: 'https:\/\/debot\.ai\/address\/robinhood'/);
  assert.match(appJs, /DEBOT_ADDRESS_ROOT = chain\.debotAddressRoot/);
  assert.match(appJs, /href="\$\{escapeHtml\(`\$\{DEBOT_ADDRESS_ROOT\}\/\$\{address\}`\)\}" target="_blank" rel="noopener noreferrer"/);
  assert.match(appJs, /data-confirm-candidate="\$\{escapeHtml\(address\)\}"/);
  assert.match(appJs, /data-exclude-candidate="\$\{escapeHtml\(address\)\}"/);
  assert.match(appJs, /method: 'PATCH',[\s\S]*status: 'active',[\s\S]*alias: walletSuggestedAlias\(wallet\)/);
  assert.match(appJs, /firstValue\(wallet, \['suggestedAlias', 'suggested_alias'\]/);
  assert.match(appJs, /return `\$\{bestSymbol\} \$\{profitRank\}`/);
  assert.match(appJs, /fetchChainJson\(context, `\/wallets\/\$\{encodeURIComponent\(normalized\)\}`, \{ method: 'DELETE' \}\)/);
  assert.match(appJs, /之后不会再出现在默认候选中/);
  assert.match(appJs, /reviewMode \? `[\s\S]*data-confirm-candidate[\s\S]*` : `[\s\S]*data-edit-wallet/);
});

test('a separate review-aware wallet request preserves confirmed annotations alongside smart candidates', () => {
  assert.match(appJs, /function buildCurationQuery\(filters\)/);
  assert.match(appJs, /params\.set\('review', filters\.status === 'excluded' \? 'excluded' : filters\.status === 'all' \? 'all' : 'confirmed'\)/);
  assert.match(appJs, /function mergeWalletCollections\(\.\.\.collections\)/);
  assert.match(appJs, /loadCurationWallets\(context, filters\)/);
});

test('summary dashboard reuses one wallet collection and only the latest completed scan batch is shown', () => {
  assert.match(appJs, /function buildPendingReviewQuery\(filters\)/);
  const pendingQuerySource = appJs.slice(
    appJs.indexOf('function buildPendingReviewQuery'),
    appJs.indexOf('function mergeWalletCollections')
  );
  assert.match(pendingQuerySource, /tab: 'all',\s*review: 'pending'/);
  assert.doesNotMatch(pendingQuerySource, /strategy|multiple|minHits|maxEntries/);
  const pendingLoaderSource = appJs.slice(
    appJs.indexOf('async function loadPendingWallets'),
    appJs.indexOf('function debotImportAlias')
  );
  assert.match(pendingLoaderSource, /buildPendingReviewQuery\(filters\)/);
  assert.match(pendingLoaderSource, /if \(!\[404, 405\]\.includes\(error\.status\)\) throw error/);
  assert.match(appJs, /const REVIEW_SCAN_BATCH_GAP_MS = 5 \* 60 \* 1000/);
  assert.match(appJs, /function latestReviewBatchTokenAddresses\(jobs\)/);
  assert.match(appJs, /batchStartedAtMs - scan\.completedAtMs > REVIEW_SCAN_BATCH_GAP_MS/);
  assert.match(appJs, /function latestReviewBatch\(wallets, jobs, winners = \[\], minimumEntryUsd = 500\)/);
  assert.match(appJs, /const snapshotAt = snapshots\.get\(tokenAddress\)/);
  assert.match(appJs, /String\(performance\?\.holderSnapshotAt \|\| ''\) !== snapshotAt/);
  assert.match(appJs, /entryCostUsd !== null && entryCostUsd >= entryFloor/);
  assert.match(appJs, /const batchHits = batchPerformances\.filter\(\(performance\) => performance\?\.hit === true\)\.length/);
  assert.match(appJs, /hits: batchHits,[\s\S]*entries: batchPerformances\.length/);
  assert.match(appJs, /function walletLibraryRecords\(collection\)/);
  const apiLoaderSource = appJs.slice(
    appJs.indexOf('async function loadApiData'),
    appJs.indexOf('function activeJobs')
  );
  assert.match(appJs, /view: 'summary'/);
  assert.match(appJs, /classification === 'all_round'.*filters\.monitorTier.*filters\.monitorTier !== 'all'/s);
  assert.match(apiLoaderSource, /const dashboardWallets = getCollection\(record, \['wallets', 'items', 'addresses'\]\) \|\| \[\]/);
  assert.match(apiLoaderSource, /const pendingWallets = pendingReviewRecords\(dashboardWallets\)/);
  assert.match(apiLoaderSource, /walletLibraryRecords\(dashboardWallets\),\s*reviewBatch\.wallets/);
  assert.match(apiLoaderSource, /loadPendingWallets\(context, filters\)/);
  assert.equal((apiLoaderSource.match(/latestReviewBatch\(pendingWallets, jobs, winners, filters\.minEntryUsd\)/g) || []).length, 2);
  assert.equal((apiLoaderSource.match(/walletLibraryRecords\(curationWallets\),\s*reviewBatch\.wallets/g) || []).length, 1);
  assert.equal((apiLoaderSource.match(/reviewBatchTokenAddresses: reviewBatch\.tokenAddresses/g) || []).length, 2);
  assert.match(appJs, /最近重扫待审核 Holder/);
  assert.match(indexHtml, /最近重扫候选/);
});

test('wallet editor persists metadata and supports soft exclusion and restoration', () => {
  assert.match(indexHtml, /<dialog class="wallet-editor" id="wallet-editor"/);
  for (const id of [
    'wallet-editor-alias',
    'wallet-editor-tags',
    'wallet-editor-status',
    'wallet-editor-monitor-tier',
    'wallet-editor-classification',
    'wallet-editor-note',
    'wallet-editor-exclude'
  ]) {
    assert.match(indexHtml, new RegExp(`id="${id}"`));
  }
  assert.match(indexHtml, /<option value="active">活跃<\/option>/);
  assert.match(indexHtml, /<option value="watch">观察<\/option>/);
  assert.match(indexHtml, /<option value="excluded">已排除<\/option>/);
  assert.match(appJs, /method: 'PATCH'/);
  assert.match(appJs, /classificationOverride: elements\.walletEditorClassification\.value \|\| null/);
  assert.match(appJs, /monitorTier: elements\.walletEditorMonitorTier\.value/);
  assert.match(appJs, /method: 'DELETE'/);
  assert.match(indexHtml, /id="wallet-editor-exclude"[\s\S]*删除并禁用/);
  assert.match(appJs, /data-disable-wallet="\$\{escapeHtml\(address\)\}"/);
  assert.match(appJs, /立即停止实时监控，可在“已排除”筛选中恢复/);
  assert.match(appJs, /params\.set\('review', filters\.status === 'excluded' \? 'excluded'/);
  assert.match(appJs, /if \(tab === 'all_round'\) return wallet\?\.curated === true/);
  assert.match(appJs, /elements\.walletEditor\.showModal\(\)/);
  assert.match(appJs, /state\.detailCache\.set\(address, payload\)/);
  assert.match(appJs, /renderWalletDetail\(updatedWallet, payload\)/);
});

test('wallet editor persists four event rules and alert choices imply monitoring', () => {
  const matrix = indexHtml.match(/<fieldset class="wallet-rule-matrix" id="wallet-monitor-rules">[\s\S]*?<\/fieldset>/)?.[0] || '';
  for (const [eventType, label] of [
    ['buy', '买入'],
    ['sell', '卖出'],
    ['transfer', '转账'],
    ['token_create', '创建代币']
  ]) {
    assert.match(matrix, new RegExp(`data-monitor-rule="${eventType}"[\\s\\S]*?wallet-rule-name">${label}<`));
  }
  assert.equal((matrix.match(/data-rule-field="enabled"/g) || []).length, 4);
  assert.equal((matrix.match(/data-rule-field="sound"/g) || []).length, 4);
  assert.equal((matrix.match(/data-rule-field="bark"/g) || []).length, 4);
  assert.match(appJs, /MONITOR_EVENT_TYPES = Object\.freeze\(\['buy', 'sell', 'transfer', 'token_create'\]\)/);
  assert.match(appJs, /const enabled = \(typeof candidate\.enabled === 'boolean'[\s\S]*\|\| sound \|\| bark/);
  assert.match(appJs, /const enabled = row\?\.querySelector\('\[data-rule-field="enabled"\]'\)\?\.checked === true \|\| sound \|\| bark/);
  assert.match(appJs, /if \(\(sound\.checked \|\| bark\.checked\) && !enabled\.checked\) enabled\.checked = true/);
  assert.match(appJs, /firstValue\(wallet, \['monitorRules', 'monitor_rules'\], \{\}\)/);
  assert.match(appJs, /monitorRules: readWalletMonitorRules\(\)/);
  assert.match(stylesCss, /\.wallet-rule-row \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) repeat\(3, 54px\)/);
});

test('confirmed wallets expose editable wallet groups without badging pending candidates', () => {
  assert.match(indexHtml, /钱包分组[\s\S]*?id="wallet-monitor-tier"[^>]*name="monitorTier"[\s\S]*?<option value="all" selected>全部分组<\/option>[\s\S]*?<option value="core">核心钱包<\/option>[\s\S]*?<option value="watch">普通观察钱包<\/option>[\s\S]*?<option value="high_frequency">高频钱包<\/option>/);
  assert.doesNotMatch(indexHtml, /监控分层|全部分层/);
  assert.match(indexHtml, /id="wallet-editor-monitor-tier"[^>]*name="monitorTier"[\s\S]*?<option value="core">核心钱包<\/option>[\s\S]*?<option value="watch">普通观察钱包<\/option>[\s\S]*?<option value="high_frequency">高频钱包<\/option>/);
  for (const [tier, label] of [['core', '核心钱包'], ['watch', '普通观察钱包'], ['high_frequency', '高频钱包']]) {
    assert.equal(appJs.includes(`${tier}: '${label}'`), true, `missing monitor tier ${tier}`);
    assert.match(stylesCss, new RegExp(`\\.monitor-tier-badge\\.${tier}`));
  }
  assert.match(appJs, /firstValue\(wallet, \['monitorTier', 'monitor_tier'\]/);
  assert.match(appJs, /if \(wallet\?\.curated !== true \|\| reviewState === 'pending'\) return ''/);
  assert.equal((appJs.match(/\$\{monitorTierBadge\(wallet\)\}/g) || []).length, 2);
  assert.match(indexHtml, /id="wallet-monitor-tier-field"[^>]*hidden/);
  assert.match(appJs, /elements\.walletMonitorTierField\.hidden = !showingConfirmedLibrary/);
  assert.match(appJs, /elements\.libraryForm\.classList\.toggle\('shows-monitor-tier', showingConfirmedLibrary\)/);
  assert.match(appJs, /elements\.walletEditorMonitorTier\.value = walletMonitorTier\(wallet\) \|\| 'watch'/);
});

test('annotation-only and holder-only wallets render without fake action history', () => {
  assert.match(appJs, /function walletHasPerformance\(wallet\)/);
  assert.match(appJs, /classification-badge unscored">待分析/);
  assert.match(appJs, /仅地址库/);
  assert.match(appJs, /暂无达到 \$\{formatMoney\(wallet\.minimumEntryUsd \?\? currentMinimumEntryUsd\(\)\)\} 买入门槛的逐币候选/);
  assert.match(stylesCss, /\.classification-badge\.unscored/);
  const buildQuerySource = appJs.slice(appJs.indexOf('function buildQuery'), appJs.indexOf('async function loadApiData'));
  assert.doesNotMatch(buildQuerySource, /classification:/);
});

test('dashboard consumes wallet library, winner, scan, patch and delete APIs', () => {
  for (const endpoint of ['/dashboard?', '/wallets?', '/winners?', '/jobs', '/jobs/scan']) {
    assert.equal(appJs.includes(endpoint), true, `missing endpoint ${endpoint}`);
  }
  assert.match(appJs, /fetchChainJson\(context, `\/wallets\/\$\{encodeURIComponent\(address\)\}`/);
  assert.match(appJs, /fetchChainJson\(context, '\/refresh'/);
  assert.match(appJs, /fetchChainJson\(context, `\/wallet\/\$\{encodeURIComponent\(address\)\}`/);
  assert.match(appJs, /getCollection\(walletsPayload, \['wallets', 'items', 'addresses'\]\)/);
});

test('token-controlled markup is escaped and remote URLs only allow HTTP protocols', () => {
  assert.match(appJs, /function escapeHtml\(value\)/);
  assert.match(appJs, /function safeHttpUrl\(value\)/);
  assert.match(appJs, /url\.protocol === 'http:' \|\| url\.protocol === 'https:'/);
  assert.match(appJs, /escapeHtml\(symbol\)/);
  assert.match(appJs, /escapeHtml\(name\)/);
  assert.match(appJs, /escapeHtml\(url\)/);
  assert.match(appJs, /rel="noopener noreferrer"/);
  assert.doesNotMatch(appJs, /innerHTML\s*=\s*[^`'"\n]*\.(?:symbol|name|logo|address)/);
});

test('wallet rows and detail expose holder rank, realized and unrealized analytics', () => {
  for (const copy of ['Holder 排名', '当前持仓', '已实现利润', '未实现利润', '总利润', '退出与流动性', '逐币持仓与收益', '累计买入']) {
    assert.equal(appJs.includes(copy), true, `missing ${copy}`);
  }
  assert.match(appJs, /walletRealized/);
  assert.match(appJs, /walletUnrealized/);
  assert.match(appJs, /walletPeak/);
  assert.match(appJs, /function walletHoldingValue\(wallet\)/);
  assert.match(appJs, /function walletHolderRank\(wallet\)/);
  assert.match(appJs, /function walletRealizedProfit\(wallet\)/);
  assert.match(appJs, /function walletUnrealizedProfit\(wallet\)/);
  assert.match(appJs, /function walletTotalProfit\(wallet\)/);
  assert.match(appJs, /positionUnrealizedProfit\(position\)/);
  assert.match(appJs, /positionHoldingValue\(position\)/);
  assert.doesNotMatch(appJs, /<dt>未实现<\/dt>[\s\S]{0,160}currentValueUsd/);
  assert.match(appJs, /position\.actions/);
  assert.match(appJs, /liquidityWarning/);
});

test('smart aggregate analytics and reason badges are visible in rows and wallet detail', () => {
  for (const helper of [
    'walletSmartScore',
    'walletEligibleEntries',
    'walletWinningEntries',
    'walletAdjustedWinRate',
    'walletTotalTradeCount',
    'walletTradesPerEntry',
    'walletNormalizedProfitScore',
    'walletProfitToPeakMarketCapRatio',
    'walletSmartReasons'
  ]) {
    assert.match(appJs, new RegExp(`function ${helper}\\(`));
  }
  for (const field of [
    'eligibleEntries',
    'eligible_entries',
    'winningEntries',
    'winning_entries',
    'adjustedWinRate',
    'adjusted_win_rate',
    'totalTradeCount',
    'total_trade_count',
    'tradesPerEntry',
    'trades_per_entry',
    'normalizedProfitScore',
    'normalized_profit_score',
    'profitToPeakMarketCapRatio',
    'profit_to_peak_market_cap_ratio'
  ]) {
    assert.equal(appJs.includes(field), true, `missing smart aggregate field ${field}`);
  }
  assert.match(appJs, /trades !== null && entries !== null && entries > 0 \? trades \/ entries : null/);
  assert.match(appJs, /reason\.code, reason\.reason, reason\.label, reason\.type/);
  for (const label of ['10x 高倍', '重仓 5x', '大额兑现 5x', '多币重复 5x', '低频高手', '关联集群']) {
    assert.equal(appJs.includes(`label: '${label}'`), true, `missing smart reason ${label}`);
  }
  for (const copy of ['相对评分', '胜场 / 有效', '加权账面胜率', '交易频率', '总交易 / 每次入场', '利润百分位', '利润 / 峰值市值']) {
    assert.equal(appJs.includes(copy), true, `missing smart UI copy ${copy}`);
  }
  assert.match(appJs, /renderSmartReasonBadges\(wallet, 3\)/);
  assert.match(appJs, /<section class="smart-analysis-band"/);
  assert.equal(appJs.includes('智能理由待补全'), false);
  assert.match(stylesCss, /\.smart-reason-badge/);
});

test('per-token analysis exposes dynamic peak-market-cap and significant-profit fields', () => {
  for (const helper of [
    'positionPeakMarketCapUsd',
    'positionSignificantProfitThresholdUsd',
    'positionProfitToPeakMarketCapRatio',
    'positionPeakMarketCapProvisional',
    'positionPeakMarketCapSource'
  ]) {
    assert.match(appJs, new RegExp(`function ${helper}\\(`));
  }
  for (const field of [
    'peakMarketCapUsd',
    'peak_market_cap_usd',
    'significantProfitThresholdUsd',
    'significantProfitUsd',
    'significant_profit_threshold_usd',
    'peakMarketCapProvisional',
    'peak_market_cap_provisional',
    'peakMarketCapSource',
    'peak_market_cap_source'
  ]) {
    assert.equal(appJs.includes(field), true, `missing per-token field ${field}`);
  }
  assert.match(appJs, /<dt>历史最高市值估算<\/dt>/);
  assert.match(appJs, /<dt>显著利润门槛<\/dt>/);
  assert.match(appJs, /provisional === false\s+\? '已核验'/);
  assert.match(appJs, /暂估状态待补全/);
  assert.match(appJs, /来源待补全/);
  assert.match(appJs, /function formatRatio\(value\)[\s\S]*number \* 100/);
  assert.match(stylesCss, /\.peak-market-cap-metric dt \{[\s\S]*white-space: normal/);
});

test('confirmed library exposes historical manual-winner hits and their peak-return basis', () => {
  for (const helper of [
    'walletManualWinnerHits',
    'walletManualWinnerParticipation',
    'walletManualWinnerHitRate',
    'walletManualWinnerHitThreshold',
    'walletHistoricalPeakMultiple',
    'positionHistoricalPeakMultiple',
    'positionHistoricalPeakReturnPercent'
  ]) {
    assert.match(appJs, new RegExp(`function ${helper}\\(`));
  }
  for (const field of [
    'manualWinnerHitCount',
    'manualWinnerParticipationCount',
    'manualWinnerHitThreshold',
    'maxHistoricalPeakMultiple',
    'historicalPeakMultiple',
    'historicalPeakReturnPercent'
  ]) {
    assert.equal(appJs.includes(field), true, `missing historical winner field ${field}`);
  }
  assert.match(appJs, /confirmedLibraryMode \? '<th>金狗历史命中<\/th>' : ''/);
  assert.match(appJs, /data-label="金狗历史命中"/);
  assert.match(appJs, /参与 \$\{formatInteger\(manualWinnerParticipation\)\} 个 · 峰值 ≥/);
  assert.match(appJs, /<dt>历史峰值收益<\/dt>/);
  assert.match(appJs, /renderMetric\('历史最高收益'/);
});

test('confirmed library exposes and refreshes monitored daily distinct-token frequency', () => {
  for (const helper of [
    'walletBuyFrequencyRecord',
    'walletAverageDailyDistinctTokens',
    'walletDistinctTokenDayCount',
    'walletBuyFrequencyObservedDays',
    'walletMaxDailyDistinctTokens'
  ]) {
    assert.match(appJs, new RegExp(`function ${helper}\\(`));
  }
  for (const field of [
    'buyFrequency',
    'averageDailyDistinctTokens',
    'distinctTokenDayCount',
    'observedDays',
    'maxDailyDistinctTokens'
  ]) {
    assert.equal(appJs.includes(field), true, `missing buy-frequency field ${field}`);
  }
  assert.match(appJs, /<th>\$\{confirmedLibraryMode \? '日均不同币' : '交易频率'\}<\/th>/);
  assert.match(appJs, /data-label="日均不同币"/);
  assert.match(appJs, /\$\{formatRequiredNumber\(averageDailyDistinctTokens\)\} 个\/天/);
  assert.match(appJs, /监控 \$\{formatInteger\(buyFrequencyObservedDays\)\} 天 · 日内去重累计/);
  assert.match(appJs, /renderMetric\('监控期日均不同币'/);
  assert.match(appJs, /BUY_FREQUENCY_REFRESH_MS = 30_000/);
  assert.match(appJs, /state\.activeTab === 'all_round' && elements\.sort\.value === 'buy_frequency'/);
  assert.match(appJs, /setTimeout\(\(\) => void loadData\(\{ quiet: true \}\), BUY_FREQUENCY_REFRESH_MS\)/);
});

test('missing smart data is explicit and no fixed significant-profit amount is presented', () => {
  assert.match(appJs, /function formatRequiredNumber\(value, options = \{\}\)[\s\S]*return '待补全'/);
  assert.match(appJs, /function formatRatio\(value\)[\s\S]*return '待补全'/);
  const visibleCopy = `${indexHtml}\n${appJs}`;
  assert.doesNotMatch(visibleCopy, /\$10k|\$10,000|10,000\s*USD/i);
  assert.doesNotMatch(visibleCopy, /显著利润门槛[\s\S]{0,120}(?:\$\s*)?10[_ ,]?000/i);
});

test('candidate leaderboard defaults to smart score and confirmed wallets default to buy frequency', () => {
  const start = indexHtml.indexOf('id="sort-select"');
  const sortMarkup = indexHtml.slice(start, indexHtml.indexOf('</select>', start));
  assert.match(sortMarkup, /value="smart_score" selected>智能评分/);
  for (const [value, label] of [
    ['name', '名称 A-Z'],
    ['buy_frequency', '日均不同币'],
    ['total_profit', '总盈利'],
    ['holding_value', '持仓市值'],
    ['holder_rank', 'Holder 排名'],
    ['realized_profit', '已实现盈利'],
    ['unrealized_profit', '未实现盈利'],
    ['best_multiple', '最高倍数'],
    ['hits', '金狗历史命中数']
  ]) {
    assert.match(sortMarkup, new RegExp(`value="${value}">${label}`));
  }
  assert.match(appJs, /sort === 'smart_score'[^\n]*walletSmartScore/);
  assert.match(appJs, /sort === 'buy_frequency'[\s\S]*walletAverageDailyDistinctTokens/);
  assert.match(appJs, /sort === 'buy_frequency'[\s\S]*walletBuyFrequencyObservedDays/);
  assert.match(appJs, /sort === 'buy_frequency'[\s\S]*walletDistinctTokenDayCount/);
  assert.match(appJs, /else result = compareNullable\(left, right, walletTotalProfit\)/);
  assert.match(appJs, /sort === 'holder_rank'[\s\S]*walletHolderRank, true/);
  assert.match(appJs, /sort === 'name'[\s\S]*localeCompare\(rightName, 'zh-CN'/);
  assert.match(appJs, /sort === 'hits'[\s\S]*walletManualWinnerHits/);
  assert.match(appJs, /if \(state\.activeTab === 'all_round'\) elements\.sort\.value = 'buy_frequency'/);
  assert.match(appJs, /else if \(elements\.sort\.value === 'buy_frequency'\) elements\.sort\.value = 'smart_score'/);
  assert.match(appJs, /\['winners', 'candidates', 'all_round'\]\.includes\(classification\) \? 'all' : classification/);
});

test('removed history and top-half screening labels stay absent', () => {
  assert.doesNotMatch(appJs, /walletDenominatorPartial|分母不完整|正式前 50%|钱包全历史账面模型/);
  assert.match(stylesCss, /\.wallet-badges/);
});

test('loading, scanning, stale, partial, error and empty states are explicit', () => {
  for (const stateName of ['loading', 'scanning', 'stale', 'partial', 'error', 'empty', 'ready']) {
    assert.equal(appJs.includes(`${stateName}: [`) || appJs.includes(`'${stateName}'`), true, `missing ${stateName}`);
  }
  assert.match(indexHtml, /aria-live="polite"/);
  assert.match(stylesCss, /\.system-status\[data-state="stale"\]/);
  assert.match(stylesCss, /\.system-status\[data-state="error"\]/);
  assert.match(stylesCss, /\.loading-state/);
  assert.match(stylesCss, /\.empty-state/);
  assert.match(stylesCss, /\.error-state/);
});

test('Lucide powers icon controls and scan controls are accessible', () => {
  assert.match(indexHtml, /<script src="vendor\/lucide\.js"><\/script>/);
  assert.match(indexHtml, /data-lucide="refresh-cw"/);
  assert.match(indexHtml, /data-lucide="radar"/);
  assert.match(indexHtml, /aria-label="刷新实时监控"/);
  assert.match(indexHtml, /title="重扫手工金狗" aria-label="重扫手工金狗"/);
  assert.match(appJs, /window\.lucide\?\.createIcons/);
});

test('relative static assets and a scoped API root support VPS prefix deployment', () => {
  assert.match(indexHtml, /href="styles\.css(?:\?[^\"]+)?"/);
  assert.match(indexHtml, /src="app\.js(?:\?[^\"]+)?"/);
  assert.equal(appJs.includes("const APP_BASE = /^\\/robinhood-radar(?:\\/|$)/.test(window.location.pathname)"), true);
  assert.match(appJs, /API_ROOT = `\$\{APP_BASE\}\/api\/\$\{chain\.apiPath\}`/);
});

test('a four-chain segmented switcher selects Robinhood, Base, BSC, and Solana independently', () => {
  const switcher = indexHtml.match(
    /<div class="chain-switcher" id="chain-switcher"[\s\S]*?<\/div>/
  )?.[0] || '';
  assert.equal((switcher.match(/data-chain=/g) || []).length, 4);
  for (const [chain, label, pressed] of [
    ['robinhood', 'Robinhood', 'true'],
    ['base', 'Base', 'false'],
    ['bsc', 'BSC', 'false'],
    ['solana', 'Solana', 'false']
  ]) {
    assert.match(
      switcher,
      new RegExp(`data-chain="${chain}"[^>]*aria-pressed="${pressed}"[\\s\\S]*?${label}`)
    );
    assert.match(appJs, new RegExp(`${chain}: Object\\.freeze\\(\\{[\\s\\S]*?id: '${chain}'`));
  }
  assert.match(appJs, /new URLSearchParams\(window\.location\.search\)\.get\('chain'\)/);
  assert.match(appJs, /Object\.hasOwn\(CHAIN_CONFIGS, requestedChain\) \? requestedChain : 'robinhood'/);
  assert.match(appJs, /elements\.chainSwitcher\.addEventListener\('click'/);
  assert.match(appJs, /switchChain\(button\.dataset\.chain\)/);
  assert.match(stylesCss, /\.chain-switcher \{[\s\S]*grid-template-columns: repeat\(4/);
  assert.match(stylesCss, /@media \(max-width: 760px\)[\s\S]*\.chain-switcher \{[\s\S]*repeat\(4, minmax\(0, 1fr\)\)/);
});

test('active-chain configuration drives API roots and browser settings keys', () => {
  const syncSource = appJs.slice(
    appJs.indexOf('function syncChainRuntimeVariables'),
    appJs.indexOf('function explorerUrl(kind')
  );
  assert.match(syncSource, /API_ROOT = `\$\{APP_BASE\}\/api\/\$\{chain\.apiPath\}`/);
  assert.match(syncSource, /EXPLORER_ROOT = chain\.explorerRoot/);
  assert.match(syncSource, /DEBOT_ADDRESS_ROOT = chain\.debotAddressRoot/);
  assert.match(syncSource, /DEBOT_TOKEN_ROOT = chain\.debotTokenRoot/);
  assert.match(syncSource, /DEBOT_WALLET_MANAGER_URL = chain\.debotWalletManagerUrl/);
  assert.match(syncSource, /MONITOR_THRESHOLD_STORAGE_KEY = `\$\{chain\.id\}-monitor-threshold`/);

  for (const [chain, apiPath] of [['robinhood', 'robinhood'], ['base', 'base'], ['bsc', 'bsc'], ['solana', 'solana']]) {
    const configStart = appJs.indexOf(`${chain}: Object.freeze({`);
    const configEnd = appJs.indexOf('\n  })', configStart);
    const config = appJs.slice(configStart, configEnd);
    assert.match(config, new RegExp(`apiPath: '${apiPath}'`));
  }

  const storageSource = appJs.slice(
    appJs.indexOf('function readStoredMonitorThreshold'),
    appJs.indexOf('function monitorTimestampMs')
  );
  assert.match(storageSource, /localStorage\.getItem\(MONITOR_THRESHOLD_STORAGE_KEY\)/);
  assert.match(storageSource, /localStorage\.setItem\(MONITOR_THRESHOLD_STORAGE_KEY/);
  assert.doesNotMatch(storageSource, /localStorage\.(?:getItem|setItem)\('robinhood-monitor-threshold'/);
});

test('Solana identities retain case while Robinhood, Base, and BSC identities normalize as EVM values', () => {
  const addressSource = appJs.slice(
    appJs.indexOf('function normalizeAddress'),
    appJs.indexOf('function shortAddress')
  );
  assert.match(addressSource, /if \(!ADDRESS_PATTERN\.test\(address\)\) return ''/);
  assert.match(addressSource, /activeChain\(\)\.family === 'evm' \? address\.toLowerCase\(\) : address/);

  const transactionSource = appJs.slice(
    appJs.indexOf('function normalizeTransactionHash'),
    appJs.indexOf('function normalizeMonitorEvent')
  );
  assert.match(transactionSource, /if \(!HASH_PATTERN\.test\(hash\)\) return ''/);
  assert.match(transactionSource, /activeChain\(\)\.family === 'evm' \? hash\.toLowerCase\(\) : hash/);

  const bscConfig = appJs.slice(
    appJs.indexOf('bsc: Object.freeze({'),
    appJs.indexOf('\n  })', appJs.indexOf('bsc: Object.freeze({'))
  );
  assert.match(bscConfig, /family: 'evm'/);
  assert.match(bscConfig, /nativeSymbol: 'BNB'/);
  assert.match(bscConfig, /addressPattern: \/\^0x\[0-9a-fA-F\]\{40\}\$\//);
  assert.match(bscConfig, /hashPattern: \/\^0x\[0-9a-fA-F\]\{64\}\$\//);

  const solanaConfig = appJs.slice(
    appJs.indexOf('solana: Object.freeze({'),
    appJs.indexOf('\n  })', appJs.indexOf('solana: Object.freeze({'))
  );
  assert.match(solanaConfig, /family: 'solana'/);
  assert.match(solanaConfig, /nativeSymbol: 'SOL'/);
  assert.match(solanaConfig, /addressPattern: \/\^\[1-9A-HJ-NP-Za-km-z\]\{32,44\}\$\//);
  assert.match(solanaConfig, /hashPattern: \/\^\[1-9A-HJ-NP-Za-km-z\]\{64,88\}\$\//);
  assert.match(appJs, /activeChain\(\)\.family === 'solana'[\s\S]*Solana Base58 Mint 地址/);
  assert.match(appJs, /event\.assetType === 'native' \? eventChain\.nativeSymbol : 'TOKEN'/);
});

test('switching the research chain preserves selected monitor feeds while invalidating stale research requests', () => {
  const stopSource = appJs.slice(
    appJs.indexOf('function stopMonitorTransport'),
    appJs.indexOf('function scheduleMonitorPoll')
  );
  assert.match(stopSource, /state\.monitorSequence \+= 1/);
  assert.match(stopSource, /for \(const session of state\.monitorSessions\.values\(\)\) stopMonitorSession\(session/);
  assert.match(stopSource, /state\.monitorEventSource = null/);

  const resetSource = appJs.slice(
    appJs.indexOf('function resetChainState'),
    appJs.indexOf('function switchChain')
  );
  for (const operation of [
    'clearManualWinnerTracking();',
    'state.requestSequence += 1;',
    'state.detailSequence += 1;',
    'state.data = null;',
    'state.visibleWallets = [];',
    'state.selectedCandidates.clear();',
    'state.rescanningWinnerAddresses.clear();',
    'state.detailCache.clear();',
    'state.monitorSettingsLoaded = false;',
    'state.monitorEnabled = true;',
    "state.monitorSound = 'alarm';",
    'state.monitorVolume = 70;',
    "state.monitorBarkSound = 'alarm';",
    'state.monitorBarkVolume = 5;',
    'setMonitorMutationControlsDisabled(true);'
  ]) {
    assert.equal(resetSource.includes(operation), true, `missing chain reset: ${operation}`);
  }
  assert.match(resetSource, /function resetChainState\(\{ preserveMonitorFeed = false \} = \{\}\)/);
  assert.match(resetSource, /if \(!preserveMonitorFeed\) stopMonitorTransport\(\{ stopSocial: false, clearEvents: true \}\)/);
  assert.match(resetSource, /else \{\s+synchronizeCombinedMonitorEvents\(\);\s+synchronizeActiveMonitorSessionState\(\);/);
  for (const sharedSocialState of [
    'socialPosts',
    'socialWatchlist',
    'socialLatestChangeId',
    'socialStreamEpoch',
    'socialEventSource',
    'socialSequence'
  ]) {
    assert.doesNotMatch(
      resetSource,
      new RegExp(`state\\.${sharedSocialState}\\s*(?:=|\\.)`),
      `chain switching must preserve shared social state: ${sharedSocialState}`
    );
  }

  const switchSource = appJs.slice(
    appJs.indexOf('function switchChain'),
    appJs.indexOf("elements.chainSwitcher.addEventListener")
  );
  assert.match(switchSource, /state\.chainAbortController\.abort\(\)/);
  assert.match(switchSource, /state\.chainEpoch \+= 1/);
  assert.match(switchSource, /activeChainId = nextChainId/);
  assert.match(switchSource, /syncChainRuntimeVariables\(\)/);
  assert.match(switchSource, /state\.chainAbortController = new AbortController\(\)/);
  assert.match(switchSource, /url\.hash = ''/);
  assert.match(switchSource, /startMonitorPage\(\{ preserveSocial: true \}\)/);
  assert.match(switchSource, /resetChainState\(\{ preserveMonitorFeed: true \}\)/);
  assert.doesNotMatch(switchSource, /(?:start|stop)SocialMonitor\(/);
  assert.ok(
    switchSource.indexOf('state.chainAbortController.abort();') < switchSource.indexOf('activeChainId = nextChainId'),
    'old-chain fetches must abort before the active chain changes'
  );
  assert.ok(
    switchSource.indexOf('state.chainAbortController = new AbortController();') < switchSource.indexOf('resetChainState({ preserveMonitorFeed: true });'),
    'new-chain operations must receive a fresh signal before loading starts'
  );

  const pollSource = appJs.slice(
    appJs.indexOf('async function pollMonitorEvents'),
    appJs.indexOf('function connectMonitorStream')
  );
  assert.match(pollSource, /const context = captureMonitorSessionContext\(session\)/);
  assert.match(pollSource, /session\.pollBusy = true/);
  assert.match(pollSource, /!monitorSessionRequestIsCurrent\(context\)/);

  const streamSource = appJs.slice(
    appJs.indexOf('function connectMonitorStream'),
    appJs.indexOf('async function startMonitorPage')
  );
  assert.match(streamSource, /new EventSource\(`\$\{context\.apiRoot\}\/monitor\/stream`\)/);
  assert.match(streamSource, /const isCurrentSource = \(\) => session\.eventSource === source && monitorSessionRequestIsCurrent\(context\)/);
  assert.match(streamSource, /if \(!isCurrentSource\(\)\) return/);

  const applyMonitorSource = appJs.slice(
    appJs.indexOf('function applyMonitorPayload'),
    appJs.indexOf('function synchronizeMonitorAlerts')
  );
  assert.match(applyMonitorSource, /state\.monitorSettingsLoaded = true;/);
  assert.match(applyMonitorSource, /setMonitorMutationControlsDisabled\(false\);/);

  const loadSource = appJs.slice(
    appJs.indexOf('async function loadData'),
    appJs.indexOf('async function startScan')
  );
  assert.match(loadSource, /const context = captureChainRequestContext\(\)/);
  assert.match(loadSource, /const sequence = \+\+state\.requestSequence/);
  assert.match(loadSource, /if \(!chainRequestIsCurrent\(context\) \|\| sequence !== state\.requestSequence\) return/);
  assert.match(loadSource, /if \(data\.chain && data\.chain !== context\.chainId\) return/);
  assert.match(appJs, /const declaredChainId = declaredMonitorChainId\(record\);\s+if \(declaredChainId !== null && declaredChainId !== session\.chainId\) return/);
  assert.match(appJs, /const declaredChainId = declaredMonitorChainId\(rawEvent\)/);
});

test('all API reads and writes use an immutable abortable chain context', () => {
  const requestHelpers = appJs.slice(
    appJs.indexOf('function captureChainRequestContext'),
    appJs.indexOf('function clampMonitorThreshold')
  );
  for (const field of [
    'chainId: activeChainId',
    'apiRoot: API_ROOT',
    'chainEpoch: state.chainEpoch',
    'signal: state.chainAbortController.signal'
  ]) {
    assert.equal(requestHelpers.includes(field), true, `missing captured chain field: ${field}`);
  }
  assert.match(requestHelpers, /return Object\.freeze\(\{/);
  assert.match(requestHelpers, /context\?\.chainId === activeChainId/);
  assert.match(requestHelpers, /context\.chainEpoch === state\.chainEpoch/);
  assert.match(requestHelpers, /context\.signal === state\.chainAbortController\.signal/);
  assert.match(requestHelpers, /fetchJson\(`\$\{context\.apiRoot\}\$\{path\}`/);
  assert.match(requestHelpers, /signal: context\.signal/);

  assert.equal((appJs.match(/\bfetchJson\(/g) || []).length, 7, 'direct API calls must be limited to shared helpers, monitor sessions, and social root');
  assert.match(appJs, /function fetchMonitorSessionJson\(context, path, options = \{\}\)[\s\S]*fetchJson\(`\$\{context\.apiRoot\}\$\{path\}`/);
  assert.match(appJs, /fetchJson\(`\$\{SOCIAL_API_ROOT\}\?postLimit=100`/);
  assert.match(appJs, /fetchJson\(`\$\{SOCIAL_API_ROOT\}\/status`/);
  assert.doesNotMatch(appJs, /\$\{API_ROOT\}\//, 'async paths must not interpolate the mutable API root');

  const guardedOperations = [
    ['saveMonitorSoundSettings', 'saveBarkSoundSettings'],
    ['createBarkTarget', 'runBarkAction'],
    ['runBarkAction', 'refreshBarkTargets'],
    ['saveMonitorSettings', 'currentMinimumEntryUsd'],
    ['exportConfirmedWalletsToDebot', 'loadApiData'],
    ['loadWalletDetail', 'renderResultsSelection'],
    ['loadData', 'startScan'],
    ['startScan', 'rescanWinner'],
    ['rescanWinner', 'addManualWinner'],
    ['addManualWinner', 'walletForAddress'],
    ['confirmCandidate', 'confirmSelectedCandidates'],
    ['confirmSelectedCandidates', 'deleteSelectedWallets'],
    ['deleteSelectedWallets', 'excludeCandidate'],
    ['excludeCandidate', 'walletBatchCount'],
    ['addManualWalletBatch', 'openWalletEditor'],
    ['saveWalletEditor', 'disableConfirmedWallet'],
    ['disableConfirmedWallet', 'excludeEditedWallet']
  ];
  for (const [name, nextName] of guardedOperations) {
    const source = appJs.slice(
      appJs.indexOf(`async function ${name}`),
      appJs.indexOf(`function ${nextName}`, appJs.indexOf(`async function ${name}`) + 1)
    );
    assert.match(source, /const context = captureChainRequestContext\(\)/, `${name} must capture its chain before awaiting`);
    assert.match(source, /(?:chainRequestIsCurrent|requireCurrentChainRequest)\(context\)/, `${name} must reject stale completion`);
  }
  const monitorSessionHelpers = appSourceBetween('function captureMonitorSessionContext(session)', 'function selectedMonitorEvents()');
  assert.match(monitorSessionHelpers, /return Object\.freeze\(\{[\s\S]*chainId: session\.chainId[\s\S]*signal: session\.abortController\.signal/);
  assert.match(monitorSessionHelpers, /context\.session\.sequence === context\.sequence/);
  assert.match(monitorSessionHelpers, /context\.session\.abortController\.signal === context\.signal/);
  assert.match(monitorSessionHelpers, /fetchJson\(`\$\{context\.apiRoot\}\$\{path\}`/);

  const resetSource = appJs.slice(
    appJs.indexOf('function resetChainState'),
    appJs.indexOf('function switchChain')
  );
  for (const control of [
    'elements.refreshButton.disabled = false;',
    'elements.manualWalletAddButton.disabled = false;',
    'elements.monitorRefreshButton.disabled = false;'
  ]) {
    assert.equal(resetSource.includes(control), true, `chain reset must release control: ${control}`);
  }
  assert.match(resetSource, /setMonitorMutationControlsDisabled\(true\);/);
  const mutationControlSource = appJs.slice(
    appJs.indexOf('function setMonitorMutationControlsDisabled'),
    appJs.indexOf('function applyMonitorPayload')
  );
  for (const control of [
    'elements.monitorSaveButton.disabled = disabled;',
    'elements.monitorSoundSaveButton.disabled = disabled;',
    'elements.monitorBarkSettingsSaveButton.disabled = disabled;',
    'elements.monitorBarkAddButton.disabled = disabled;'
  ]) {
    assert.equal(mutationControlSource.includes(control), true, `missing guarded monitor mutation control: ${control}`);
  }
});

test('live monitor refreshes preserve an unsaved settings draft', () => {
  const renderSource = appSourceBetween('function renderMonitorPage()', 'function setMonitorMutationControlsDisabled');
  assert.match(renderSource, /if \(!state\.monitorSettingsDirty && !state\.monitorSettingsSaving\)/);
  assert.match(renderSource, /elements\.monitorThreshold\.value = String\(state\.monitorThreshold\)/);
  assert.match(renderSource, /elements\.monitorWindowSeconds\.value = String\(state\.monitorWindowSeconds\)/);
  assert.match(renderSource, /elements\.monitorEnabled\.checked = state\.monitorEnabled/);

  const saveSource = appSourceBetween('async function saveMonitorSettings', 'function currentMinimumEntryUsd');
  assert.match(saveSource, /state\.monitorSettingsSaving = true/);
  assert.match(saveSource, /state\.monitorSettingsSaving = false;\s+renderMonitorPage\(\)/);
  assert.match(saveSource, /state\.monitorSettingsDirty = true;\s+renderMonitorPage\(\)/);

  assert.match(appJs, /elements\.monitorSettingsForm\.addEventListener\('input',[\s\S]*state\.monitorSettingsDirty = true/);
  const resetSource = appSourceBetween('function resetChainState', 'function switchChain');
  assert.match(resetSource, /state\.monitorSettingsDirty = false/);
  assert.match(resetSource, /state\.monitorSettingsSaving = false/);
});

test('DeBot and explorer links use the active chain for research and each event chain for the mixed monitor feed', () => {
  for (const [chain, debotAddress, debotToken, manager, explorer] of [
    ['robinhood', 'https://debot.ai/address/robinhood', 'https://debot.ai/token/robinhood/289942_', 'https://debot.ai/track?chain=robinhood&tab=manager', 'https://robinhoodchain.blockscout.com'],
    ['base', 'https://debot.ai/address/base', 'https://debot.ai/token/base/289942_', 'https://debot.ai/track?chain=base&tab=manager', 'https://base.blockscout.com'],
    ['bsc', 'https://debot.ai/address/bsc', 'https://debot.ai/token/bsc/289942_', 'https://debot.ai/track?chain=bsc&tab=manager', 'https://bscscan.com'],
    ['solana', 'https://debot.ai/address/solana', 'https://debot.ai/token/solana/289942_', 'https://debot.ai/track?chain=solana&tab=manager', 'https://solscan.io']
  ]) {
    const configStart = appJs.indexOf(`${chain}: Object.freeze({`);
    const configEnd = appJs.indexOf('\n  })', configStart);
    const config = appJs.slice(configStart, configEnd);
    assert.ok(configStart >= 0 && configEnd > configStart);
    assert.equal(config.includes(`debotAddressRoot: '${debotAddress}'`), true);
    assert.equal(config.includes(`debotTokenRoot: '${debotToken}'`), true);
    assert.equal(config.includes(`debotWalletManagerUrl: '${manager}'`), true);
    assert.equal(config.includes(`explorerRoot: '${explorer}'`), true);
  }

  const explorerSource = appJs.slice(
    appJs.indexOf('function explorerUrl(kind'),
    appJs.indexOf('syncChainRuntimeVariables();')
  );
  assert.match(explorerSource, /const chain = activeChain\(\)/);
  assert.match(explorerSource, /chain\.explorerTokenPath/);
  assert.match(explorerSource, /chain\.explorerTxPath/);
  assert.match(explorerSource, /chain\.explorerAddressPath/);
  assert.match(explorerSource, /return `\$\{chain\.explorerRoot\}\/\$\{path\}\/\$\{normalized\}`/);

  const monitorRender = appJs.slice(
    appJs.indexOf('function renderMonitorEvents'),
    appJs.indexOf('function renderMonitorPage')
  );
  assert.match(monitorRender, /const eventChain = monitorChain\(event\.chain\)/);
  assert.match(monitorRender, /`\$\{eventChain\.debotAddressRoot\}\/\$\{event\.walletAddress\}`/);
  assert.match(monitorRender, /`\$\{eventChain\.debotTokenRoot\}\$\{event\.tokenAddress\}`/);
  assert.match(monitorRender, /explorerUrlForChain\(eventChain\.id, 'tx', event\.txHash\)/);
  assert.doesNotMatch(monitorRender, /robinhoodchain|basescan|solscan/i);
  assert.match(appJs, /managerLink\.href = context\.debotWalletManagerUrl/);
  assert.match(appJs, /explorerUrl\('address', address\)/);
  assert.match(appJs, /explorerUrl\('token', address\)/);
});

test('responsive layout keeps controls, wallet metadata and dialog inside the viewport', () => {
  assert.match(stylesCss, /@media \(max-width: 760px\)/);
  assert.match(stylesCss, /\.research-table tbody tr \{[\s\S]*display: grid/);
  assert.match(stylesCss, /\.research-table thead \{[\s\S]*display: none/);
  assert.match(stylesCss, /\.research-table \.wallet-cell \{[\s\S]*min-height: 78px/);
  assert.match(stylesCss, /\.wallet-table tbody tr \{[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(stylesCss, /\.wallet-table \.data-status-cell \{[\s\S]*grid-column: 1 \/ -1/);
  assert.match(stylesCss, /\.wallet-table \.smart-score-cell,[\s\S]*\.wallet-table \.smart-frequency-cell \{[\s\S]*min-width: 0/);
  assert.match(stylesCss, /\.smart-analysis-grid \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(stylesCss, /\.detail-identity \.detail-address-line/);
  assert.match(stylesCss, /\.wallet-editor \{[\s\S]*calc\(100vw - 24px\)/);
  assert.match(stylesCss, /\.detail-panel \{[\s\S]*min-height: calc\(100svh - 20px\)/);
  assert.match(appJs, /window\.matchMedia\('\(max-width: 760px\)'\)/);
});

test('the candidate queue defaults to one hit from the latest scan batch', () => {
  assert.match(appJs, /return walletCandidateEligible\(wallet\) \|\| walletHasPerformance\(wallet\)/);
  assert.doesNotMatch(appJs, /smartDecision !== null\) return smartDecision/);
  assert.match(appJs, /minHits: Math\.max\(0, Math\.floor\(finiteNumber\(form\.get\('minHits'\)\) \?\? 1\)\)/);
  assert.equal((appJs.match(/elements\.minHits\.value = '1'/g) || []).length, 3);
  assert.match(appJs, /status === 'complete' && walletHolderRank\(wallet\) !== null/);
});

test('removed candidate subdivisions cannot enter selection mode', () => {
  assert.match(appJs, /function isCandidateReviewTab\(tab = state\.activeTab\) \{\s+return tab === 'candidates';\s+\}/);
  assert.doesNotMatch(indexHtml, /data-tab="(?:realized|unrealized|single_hit)"/);
});

test('real-time monitoring is the default first-level page and replaces the research workspace cleanly', () => {
  assert.match(indexHtml, /data-tab="monitor"[^>]*aria-selected="true"[\s\S]*?实时监控/);
  assert.doesNotMatch(indexHtml, /id="monitor-page"[^>]*hidden/);
  assert.match(indexHtml, /id="research-board"[^>]*hidden/);
  assert.match(appJs, /syncToolbarVisibility\(\);\s+refreshIcons\(\);\s+void startMonitorPage\(\);/);
  for (const id of [
    'monitor-settings-form',
    'monitor-health-status',
    'monitor-wallet-count',
    'monitor-latest-block',
    'monitor-block-lag',
    'monitor-fast-backlog',
    'monitor-fast-gap',
    'monitor-fast-duration',
    'monitor-deep-status',
    'monitor-deep-live-backlog',
    'monitor-deep-gap',
    'monitor-deep-duration',
    'telegram-monitor-panel',
    'telegram-message-feed',
    'telegram-ca-watch-button',
    'telegram-ca-watch',
    'telegram-ca-watch-enabled',
    'telegram-ca-watch-search',
    'telegram-ca-watch-select-all',
    'telegram-ca-watch-list',
    'telegram-ca-watch-save',
    'social-monitor-panel',
    'social-watchlist-manager',
    'telegram-social-refresh',
    'telegram-social-manager-summary',
    'telegram-social-search',
    'telegram-social-select-all',
    'telegram-social-chat-list',
    'telegram-social-selected-count',
    'telegram-social-save',
    'social-monitor-summary',
    'social-feed',
    'monitor-event-feed'
  ]) {
    assert.match(indexHtml, new RegExp(`id="${id}"`));
  }
  assert.match(appJs, /elements\.submissionDock\.hidden = showingMonitor/);
  assert.match(appJs, /elements\.researchBoard\.hidden = showingMonitor/);
  assert.match(appJs, /elements\.monitorPage\.hidden = !showingMonitor/);
  assert.match(appJs, /if \(state\.activeTab === 'monitor'\)[\s\S]*startMonitorPage/);
});

test('the pinned LazyCat Telegram panel precedes the shared monitoring workspace', () => {
  const telegramPanelIndex = indexHtml.indexOf('<section class="telegram-monitor-panel"');
  const feishuPanelIndex = indexHtml.indexOf('<section class="telegram-monitor-panel feishu-monitor-panel"');
  const workspaceIndex = indexHtml.indexOf('<div class="monitor-workspace">');
  const socialPanelIndex = indexHtml.indexOf('<section class="social-monitor-panel"');
  const managerIndex = indexHtml.indexOf('<section class="social-watchlist-manager"');
  const telegramControlsIndex = indexHtml.indexOf('<section class="telegram-social-watchlist"');
  const socialFeedIndex = indexHtml.indexOf('<div class="social-feed"');

  assert.ok(telegramPanelIndex > 0);
  assert.ok(telegramPanelIndex < workspaceIndex);
  assert.match(indexHtml.slice(telegramPanelIndex, feishuPanelIndex), /id="telegram-monitor-panel"[\s\S]*id="telegram-message-feed"[\s\S]*<\/section>\s*$/);
  assert.ok(workspaceIndex < socialPanelIndex);
  assert.ok(socialPanelIndex > 0);
  assert.ok(socialPanelIndex < managerIndex);
  assert.ok(managerIndex < telegramControlsIndex);
  assert.ok(telegramControlsIndex < socialFeedIndex);
  const managerMarkup = indexHtml.slice(managerIndex, socialFeedIndex);
  for (const id of [
    'telegram-social-refresh',
    'telegram-social-manager-summary',
    'telegram-social-search',
    'telegram-social-select-all',
    'telegram-social-chat-list',
    'telegram-social-selected-count',
    'telegram-social-save'
  ]) {
    assert.match(managerMarkup, new RegExp(`id="${id}"`));
  }

  assert.doesNotMatch(indexHtml, /social-telegram-section|social-telegram-feed/);
  assert.match(indexHtml, /<script src="telegram-monitor\.js" type="module"><\/script>/);
  assert.match(indexHtml, /<script src="telegram-social\.js" type="module"><\/script>/);
});

test('Telegram and Feishu real-time chats share a responsive two-column workspace', () => {
  const chatGridIndex = indexHtml.indexOf('<div class="chat-monitor-grid">');
  const telegramIndex = indexHtml.indexOf('id="telegram-monitor-panel"');
  const feishuIndex = indexHtml.indexOf('id="feishu-monitor-panel"');
  const monitorWorkspaceIndex = indexHtml.indexOf('<div class="monitor-workspace">');
  assert.ok(chatGridIndex > 0 && chatGridIndex < telegramIndex);
  assert.ok(telegramIndex < feishuIndex && feishuIndex < monitorWorkspaceIndex);
  for (const id of [
    'feishu-message-feed',
    'feishu-latest-button',
    'feishu-person-filter',
    'feishu-ca-watch-button',
    'feishu-ca-watch-enabled',
    'feishu-ca-watch-list',
    'feishu-ca-watch-save'
  ]) assert.match(indexHtml, new RegExp(`id="${id}"`));
  assert.match(indexHtml, /<script src="feishu-monitor\.js" type="module"><\/script>/);
  assert.match(stylesCss, /\.chat-monitor-grid \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(stylesCss, /@media[\s\S]*\.chat-monitor-grid \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(feishuMonitorJs, /new EventSource\(`\$\{FEISHU_API_ROOT\}\/stream`\)/);
  assert.match(feishuMonitorJs, /fetchJson\('\/ca-watch', \{[\s\S]*method: 'PUT'/);
  assert.match(feishuMonitorJs, /function scrollToLatest\([\s\S]*elements\.feed\.scrollTo/);
  assert.match(feishuMonitorJs, /state\.selectedPersonId = elements\.filter\.value/);
});

test('Feishu monitor browser script is syntactically valid', () => {
  assert.doesNotThrow(() => new Function(feishuMonitorJs));
});

test('the pinned Telegram viewer targets LazyCat FNF by chat id and stays read only', () => {
  assert.match(telegramMonitorJs, /TELEGRAM_PINNED_SOURCE_NAME = 'LazyCat FNF'/);
  const sourceLookup = telegramMonitorJs.slice(
    telegramMonitorJs.indexOf('async function ensureTelegramPinnedSource'),
    telegramMonitorJs.indexOf('function scheduleTelegramLoad')
  );
  assert.match(sourceLookup, /fetchTelegramJson\('\/chats'/);
  assert.match(sourceLookup, /startsWith\(TELEGRAM_PINNED_SOURCE_NAME\)/);
  assert.match(sourceLookup, /body: \{ chat_ids: \[sourceId, \.\.\.selectedIds\] \}/);
  assert.match(telegramMonitorJs, /`\/messages\?limit=\$\{TELEGRAM_MESSAGE_LIMIT\}&chat_id=\$\{encodeURIComponent\(sourceId\)\}`/);
  assert.match(telegramMonitorJs, /feed\.scrollTop[\s\S]*row\.getBoundingClientRect\(\)\.top[\s\S]*feed\.getBoundingClientRect\(\)\.top/);
  assert.match(indexHtml, /class="telegram-feed-shell"[\s\S]*id="telegram-message-feed"[\s\S]*id="telegram-latest-button"[^>]*title="跳到最新消息"[^>]*aria-controls="telegram-message-feed"[^>]*hidden/);
  assert.match(telegramMonitorJs, /function scrollTelegramToLatest\(\{ behavior = 'smooth' \} = \{\}\) \{[\s\S]*feed\.scrollTo\(\{ top: feed\.scrollHeight, behavior \}\)/);
  assert.match(telegramMonitorJs, /function updateTelegramLatestButton\(\) \{[\s\S]*distanceFromLatest = feed\.scrollHeight - feed\.scrollTop - feed\.clientHeight[\s\S]*latestButton\.hidden = !hasMessages \|\| distanceFromLatest <= 24/);
  assert.match(telegramMonitorJs, /latestButton\.addEventListener\('click', \(\) => scrollTelegramToLatest\(\)\)/);
  assert.match(telegramMonitorJs, /feed\.addEventListener\('scroll', updateTelegramLatestButton, \{ passive: true \}\)/);
  assert.match(stylesCss, /\.telegram-feed-shell \{[\s\S]*position: relative;/);
  assert.match(stylesCss, /\.telegram-latest-button \{[\s\S]*position: absolute;[\s\S]*right: 18px;[\s\S]*bottom: 18px;[\s\S]*width: 30px;[\s\S]*height: 30px;/);
  assert.match(telegramMonitorJs, /credentials: 'same-origin'/);
  assert.doesNotMatch(telegramMonitorJs, /send_message|send_file|forward_messages|edit_message|delete_messages/);
  assert.match(stylesCss, /\.telegram-reply \.telegram-media\.is-compact img,[\s\S]*max-width: 46px;[\s\S]*max-height: 34px;/);
});

test('the pinned Telegram panel configures server-side CA Bark rules by sender id', () => {
  const panel = indexHtml.slice(
    indexHtml.indexOf('<section class="telegram-monitor-panel"'),
    indexHtml.indexOf('<div class="monitor-workspace">')
  );
  for (const id of [
    'telegram-ca-watch-button',
    'telegram-ca-watch',
    'telegram-ca-watch-status',
    'telegram-ca-watch-enabled',
    'telegram-ca-watch-search',
    'telegram-ca-watch-select-all',
    'telegram-ca-watch-list',
    'telegram-ca-watch-save'
  ]) {
    assert.match(panel, new RegExp(`id="${id}"`));
  }
  assert.match(telegramMonitorJs, /fetchTelegramJson\('\/ca-watch'\)/);
  assert.match(telegramMonitorJs, /fetchTelegramJson\('\/ca-watch', \{[\s\S]*method: 'PUT'/);
  assert.match(telegramMonitorJs, /sender_ids: \[\.\.\.state\.draftSenderIds\]/);
  assert.match(telegramMonitorJs, /selected_sender_ids/);
  assert.match(telegramMonitorJs, /delivery_configured/);
  assert.match(telegramMonitorJs, /TELEGRAM_CA_WATCH_REFRESH_INTERVAL_MS = 10_000/);
  assert.match(telegramMonitorJs, /loadTelegramCaWatch\(\{ silent: true \}\)/);
  assert.match(telegramMonitorJs, /window\.setInterval\([\s\S]*TELEGRAM_CA_WATCH_REFRESH_INTERVAL_MS/);
  assert.match(telegramMonitorJs, /preserveDraft/);
  assert.match(telegramMonitorJs, /requestEpoch = \+\+state\.requestEpoch/);
  assert.match(telegramMonitorJs, /requestEpoch !== state\.requestEpoch/);
  assert.match(telegramMonitorJs, /state\.busy \|\| state\.refreshing/);
  assert.match(telegramMonitorJs, /caWatchList\.scrollTop/);
  assert.match(telegramMonitorJs, /EVM \/ Solana 地址/);
  assert.match(stylesCss, /\.telegram-ca-watch-option \{[\s\S]*grid-template-columns:/);
  assert.match(stylesCss, /\.telegram-reply \.telegram-media\.is-compact \{[\s\S]*width: 46px;[\s\S]*height: 34px;/);
});

test('Telegram is a read-only source merged chronologically with X in the existing social feed', () => {
  assert.match(telegramSocialJs, /TELEGRAM_SOCIAL_POLL_MS = 2_000/);
  assert.match(telegramSocialJs, /telegramSocialFetchJson\('\/chats'/);
  assert.match(telegramSocialJs, /telegramSocialFetchJson\(`\/messages\?limit=\$\{TELEGRAM_SOCIAL_MESSAGE_LIMIT\}`/);
  assert.match(telegramSocialJs, /telegramSocialFetchJson\('\/selection',[\s\S]*method: 'POST'/);
  assert.match(telegramSocialJs, /body: \{ chat_ids: chatIds, ca_bark_chat_ids: caBarkChatIds \}/);
  assert.match(telegramSocialJs, /message\?\.stream_id \?\? message\?\.streamId/);
  assert.match(telegramSocialJs, /credentials: 'same-origin'/);
  assert.match(telegramSocialJs, /new CustomEvent\('telegram-social-update', \{ detail: snapshot \}\)/);
  assert.doesNotMatch(telegramSocialJs, /send_message|send_file|forward_messages|edit_message|delete_messages|innerHTML\s*=/);

  const telegramMarkupSource = appJs.slice(
    appJs.indexOf('function telegramSocialMediaMarkup'),
    appJs.indexOf('function socialFeedItems()')
  );
  for (const className of [
    'social-post',
    'social-avatar',
    'social-post-content',
    'social-reply-context',
    'social-post-media'
  ]) {
    assert.match(telegramMarkupSource, new RegExp(`class="[^"]*${className}`));
  }
  assert.match(telegramMarkupSource, /data-source="telegram"/);

  const mergedFeedSource = appSourceBetween('function socialFeedItems()', 'function renderSocialBridgeStatus()');
  assert.match(mergedFeedSource, /const visiblePosts = visibleSocialPosts\(\)/);
  assert.match(mergedFeedSource, /visibleTelegramSocialMessages\(\)\.map/);
  assert.match(mergedFeedSource, /type: 'social',[\s\S]*post/);
  assert.match(mergedFeedSource, /type: 'telegram',[\s\S]*message/);
  assert.match(mergedFeedSource, /return \[\.\.\.socialItems, \.\.\.groupedFomo, \.\.\.telegramItems\]/);
  assert.match(mergedFeedSource, /\.sort\(\(left, right\) => right\.timestamp - left\.timestamp\)/);

  const renderFeedSource = appSourceBetween('function renderSocialFeed()', 'function renderSocialMonitor()');
  assert.match(renderFeedSource, /keyedFeedMarkup\(telegramSocialPostMarkup\(item\.message\), key\)/);
  assert.match(appJs, /window\.addEventListener\('telegram-social-update', \(\) => \{[\s\S]*renderSocialFeed\(\)/);
});

test('the pinned LazyCat chat stays out of the lower selector and feed but remains selected on the backend', () => {
  assert.match(telegramSocialJs, /TELEGRAM_SOCIAL_PINNED_NAME = 'LazyCat FNF'/);

  const visibleChatsSource = telegramSocialJs.slice(
    telegramSocialJs.indexOf('function telegramSocialVisibleChats()'),
    telegramSocialJs.indexOf('function telegramSocialRenderAvatar')
  );
  assert.match(visibleChatsSource, /telegramSocialState\.chats\.filter\(\(chat\) => chat\.id !== telegramSocialPinnedId\(\)\)/);

  const publishSource = telegramSocialJs.slice(
    telegramSocialJs.indexOf('function telegramSocialPublish('),
    telegramSocialJs.indexOf('async function telegramSocialLoadChats')
  );
  assert.match(publishSource, /\.filter\(\(message\) => !telegramSocialIsPinnedMessage\(message\)\)/);
  assert.match(publishSource, /\.filter\(\(source\) => telegramSocialNumericId\(source\?\.id\) !== telegramSocialPinnedId\(\)/);

  const saveSource = telegramSocialJs.slice(
    telegramSocialJs.indexOf('async function telegramSocialSaveSelection()'),
    telegramSocialJs.indexOf('function telegramSocialStart()')
  );
  assert.match(saveSource, /const pinnedId = telegramSocialPinnedId\(\)/);
  assert.match(saveSource, /const chatIds = \[pinnedId, \.\.\.selectedChatIds\.filter\(\(id\) => id !== pinnedId\)\]/);
  assert.match(saveSource, /body: \{ chat_ids: chatIds, ca_bark_chat_ids: caBarkChatIds \}/);
});

test('Telegram channel selection keeps unsaved edits across polling and rejects pre-save responses', () => {
  const syncSource = telegramSocialJs.slice(
    telegramSocialJs.indexOf('function telegramSocialSyncCatalog('),
    telegramSocialJs.indexOf('function telegramSocialSetsEqual(')
  );
  assert.match(syncSource, /ignoreSelection = false/);
  assert.match(syncSource, /selected && !ignoreSelection && !telegramSocialState\.selectionBusy/);
  assert.match(syncSource, /if \(!telegramSocialState\.draftDirty\)[\s\S]*draftChatIds = new Set\(selected\)/);

  const draftChangeSource = telegramSocialJs.slice(
    telegramSocialJs.indexOf('function telegramSocialRecordDraftChange('),
    telegramSocialJs.indexOf('function telegramSocialVisibleChats(')
  );
  assert.match(draftChangeSource, /telegramSocialState\.draftRevision \+= 1/);
  assert.match(draftChangeSource, /draftDirty = !telegramSocialSetsEqual/);
  assert.ok((telegramSocialJs.match(/telegramSocialRecordDraftChange\(\)/g) || []).length >= 3);

  const loadChatsSource = telegramSocialJs.slice(
    telegramSocialJs.indexOf('async function telegramSocialLoadChats('),
    telegramSocialJs.indexOf('function telegramSocialSchedule(')
  );
  assert.match(loadChatsSource, /const selectionEpoch = telegramSocialState\.selectionEpoch/);
  assert.match(loadChatsSource, /ignoreSelection: selectionEpoch !== telegramSocialState\.selectionEpoch/);

  const saveSource = telegramSocialJs.slice(
    telegramSocialJs.indexOf('async function telegramSocialSaveSelection()'),
    telegramSocialJs.indexOf('function telegramSocialStart()')
  );
  assert.match(saveSource, /telegramSocialState\.selectionEpoch \+= 1/);
  assert.match(saveSource, /messagesController\?\.abort\(\)/);
  assert.match(saveSource, /catalogController\?\.abort\(\)/);
  assert.match(saveSource, /telegramSocialSyncCatalog\(payload, \{ ignoreSelection: true \}\)/);
  assert.match(saveSource, /telegramSocialState\.draftRevision === saveRevision[\s\S]*draftDirty = false/);
  assert.match(saveSource, /保存失败：[\s\S]*selectedChatIds = previousSelected/);
  assert.match(telegramSocialJs, /telegramSocialPublish\(payload, '', \{ ignoreSelection \}\)/);
});

test('monitor health exposes compact fast and deep lane diagnostics', () => {
  const healthGrid = indexHtml.match(/<dl class="monitor-health-grid" aria-label="实时监控状态">[\s\S]*?<\/dl>/)?.[0] || '';
  assert.equal((healthGrid.match(/<div>/g) || []).length, 6);
  assert.match(healthGrid, /快线积压[\s\S]*id="monitor-fast-backlog"[\s\S]*id="monitor-fast-gap"[\s\S]*id="monitor-fast-duration"/);
  assert.match(healthGrid, /深扫状态[\s\S]*id="monitor-deep-status"[\s\S]*id="monitor-deep-live-backlog"[\s\S]*id="monitor-deep-gap"[\s\S]*id="monitor-deep-duration"/);
  assert.doesNotMatch(healthGrid, /<(?:section|article)\b/);

  for (const field of [
    'fastBacklogBlocks',
    'fastGapBlocks',
    'fastLastRangeDurationMs',
    'deepLiveBacklogBlocks',
    'deepLastRangeDurationMs',
    'deepGapBlocks'
  ]) {
    const snake = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    assert.match(appJs, new RegExp(`health\\.${field}, health\\.${snake}`));
  }
  assert.match(appJs, /firstValue\(health, \['deepStatus', 'deep_status'\]/);
  for (const [status, label] of [
    ['disabled', '停用'],
    ['idle', '待命'],
    ['backfilling', '回补中'],
    ['caught_up', '已追平'],
    ['degraded', '降级'],
    ['error', '异常']
  ]) {
    assert.equal(appJs.includes(`${status}: '${label}'`), true, `missing deep status ${status}`);
  }
  assert.match(appJs, /function formatMonitorBlockCount\(value\)/);
  assert.match(appJs, /function formatMonitorRangeDuration\(value\)/);
  assert.match(appJs, /elements\.monitorFastBacklog\.textContent = formatMonitorBlockCount\(health\.fastBacklogBlocks\)/);
  assert.match(appJs, /elements\.monitorFastGap\.textContent = `缺口 \$\{formatMonitorBlockCount\(health\.fastGapBlocks\)\}`/);
  assert.match(appJs, /elements\.monitorDeepStatus\.textContent = formatMonitorDeepStatus\(health\.deepStatus\)/);
  assert.match(appJs, /elements\.monitorDeepLiveBacklog\.textContent = `实时 \$\{formatMonitorBlockCount\(health\.deepLiveBacklogBlocks\)\}`/);
  assert.match(appJs, /elements\.monitorDeepGap\.textContent = `缺口 \$\{formatMonitorBlockCount\(health\.deepGapBlocks\)\}`/);
  assert.match(appJs, /elements\.monitorDeepDuration\.textContent = `上轮 \$\{formatMonitorRangeDuration\(health\.deepLastRangeDurationMs\)\}`/);

  assert.match(stylesCss, /\.monitor-health-grid \{[\s\S]*grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(stylesCss, /@media \(max-width: 960px\)[\s\S]*\.monitor-health-grid \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(stylesCss, /@media \(max-width: 760px\)[\s\S]*\.monitor-health-grid \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(stylesCss, /\.monitor-health-grid \.monitor-health-details \{[\s\S]*flex-wrap: wrap/);
});

test('Solana monitor readiness is explicit when Helius is not configured', () => {
  const healthSource = appJs.slice(
    appJs.indexOf('function monitorHealthValues'),
    appJs.indexOf('function renderMonitorSoundStatus')
  );
  assert.match(healthSource, /realtimeReady: typeof health\.realtimeReady === 'boolean'/);
  assert.match(healthSource, /Array\.isArray\(health\.reasons\)/);
  assert.match(healthSource, /helius_api_key_missing/);
  assert.match(healthSource, /缺少 Helius Key，仅 Holder 可用/);

  const renderSource = appJs.slice(
    appJs.indexOf('function monitorConnectionState'),
    appJs.indexOf('function socialPostKey')
  );
  assert.match(renderSource, /health\.realtimeReady === false/);
  assert.match(renderSource, /label: '实时未配置'/);
  assert.match(renderSource, /readinessDetail \? '配置未完成'/);
});

test('monitor settings persist a bounded threshold and customizable alert window', () => {
  assert.match(indexHtml, /id="monitor-threshold"[^>]*min="1"[^>]*max="1000"/);
  assert.match(indexHtml, /id="monitor-window-seconds"[^>]*name="windowSeconds"[^>]*min="5"[^>]*max="3600"[^>]*value="60"/);
  assert.match(indexHtml, /id="monitor-enabled"[^>]*type="checkbox"/);
  assert.match(appJs, /Math\.min\(1000, Math\.max\(1, Math\.floor\(number\)\)\)/);
  assert.match(appJs, /Math\.min\(3600, Math\.max\(5, Math\.floor\(number\)\)\)/);
  assert.match(appJs, /MONITOR_THRESHOLD_STORAGE_KEY = 'robinhood-monitor-threshold'/);
  assert.match(appJs, /window\.localStorage\.setItem\(MONITOR_THRESHOLD_STORAGE_KEY/);
  assert.match(appJs, /state\.monitorWindowSeconds = clampMonitorWindowSeconds\(serverWindowSeconds, state\.monitorWindowSeconds\)/);
  assert.match(appJs, /elements\.monitorWindowSeconds\.value = String\(state\.monitorWindowSeconds\)/);
  assert.match(appJs, /fetchChainJson\(context, '\/monitor\/settings', \{[\s\S]*method: 'PATCH'[\s\S]*JSON\.stringify\(\{ threshold, windowSeconds, enabled \}\)/);
  assert.match(appJs, /服务端保存失败，已保存在本机/);
});

test('monitoring prefers SSE event delivery and falls back to two-second incremental polling', () => {
  assert.match(appJs, /new EventSource\(`\$\{context\.apiRoot\}\/monitor\/stream`\)/);
  for (const eventType of ['snapshot', 'event', 'buy', 'sell', 'transfer', 'token_create', 'health']) {
    assert.match(appJs, new RegExp(`source\\.addEventListener\\('${eventType}'`));
  }
  assert.match(appJs, /MONITOR_POLL_INTERVAL_MS = 2_000/);
  assert.match(appJs, /MONITOR_RECENT_REFRESH_MS = 10_000/);
  assert.match(appJs, /refreshRecent \? '0' : session\.lastEventId/);
  assert.match(appJs, /\/monitor\/events\?after=\$\{after\}&limit=200/);
  assert.match(appJs, /\/monitor\?since=\$\{after\}&limit=200/);
  assert.match(appJs, /session\.transport === 'sse'/);
  assert.match(appJs, /session\.events\.sort\(\(left, right\) => monitorEventTimestamp\(right\) - monitorEventTimestamp\(left\)\)/);
  assert.match(appJs, /source\.addEventListener\('error',[\s\S]*session\.eventSource = null[\s\S]*scheduleMonitorPoll\(session, 0\)/);
});

test('real-time chain flow independently multi-selects and persists all four chains', () => {
  const filter = indexHtml.match(/<fieldset class="monitor-chain-filter"[\s\S]*?<\/fieldset>/)?.[0] || '';
  assert.equal((filter.match(/type="checkbox"/g) || []).length, 4);
  for (const [chainId, label] of [
    ['robinhood', 'Robinhood'],
    ['base', 'Base'],
    ['bsc', 'BSC'],
    ['solana', 'Solana']
  ]) {
    assert.match(filter, new RegExp(`data-monitor-chain="${chainId}"[\\s\\S]*?value="${chainId}"[\\s\\S]*?${label}`));
  }
  assert.match(appJs, /MONITOR_FEED_CHAINS_STORAGE_KEY = '1874catch-monitor-feed-chains'/);
  assert.match(appJs, /localStorage\.getItem\(MONITOR_FEED_CHAINS_STORAGE_KEY\)/);
  assert.match(appJs, /localStorage\.setItem\(MONITOR_FEED_CHAINS_STORAGE_KEY, JSON\.stringify\(ordered\)\)/);
  assert.match(appJs, /state\.monitorFeedChainIds = readStoredMonitorFeedChainIds\(\)/);
  assert.match(appJs, /if \(!next\.size\) \{[\s\S]*实时链上流水至少保留一条链/);
  assert.match(appJs, /elements\.monitorChainFilter\?\.addEventListener\('change'/);
  assert.match(appJs, /resetChainState\(\{ preserveMonitorFeed: true \}\)/);
});

test('multi-chain monitor sessions keep identities, cursors, streams and merged ordering isolated', () => {
  const sessionSource = appSourceBetween('function createMonitorSession(chainId)', 'function captureMonitorSessionContext(session)');
  for (const field of [
    'abortController: new AbortController()',
    'eventSource: null',
    'pollTimer: null',
    'events: []',
    'eventKeys: new Set()',
    "lastEventId: ''",
    'recentRefreshAt: 0'
  ]) {
    assert.equal(sessionSource.includes(field), true, `missing per-chain monitor state: ${field}`);
  }
  assert.match(appJs, /monitorSessions: new Map\(\)/);
  assert.match(appJs, /if \(event\.id\) return `\$\{chainId\}:id:\$\{event\.id\}`/);
  assert.match(appJs, /return `\$\{chainId\}:\$\{identity\}`/);
  assert.match(appJs, /const previous = Number\(session\.lastEventId\)/);
  assert.match(appJs, /session\.lastEventId = String\(Math\.max/);

  const selectedMonitorEvents = Function(
    'state',
    'monitorSession',
    'monitorEventTimestamp',
    'MONITOR_FEED_EVENT_LIMIT',
    `${appSourceBetween('function selectedMonitorEvents()', 'function synchronizeCombinedMonitorEvents()')}\nreturn selectedMonitorEvents;`
  )(
    { monitorFeedChainIds: new Set(['robinhood', 'bsc']) },
    (chainId) => ({
      events: chainId === 'robinhood'
        ? [{ chain: chainId, id: '1', timestamp: 100 }]
        : [{ chain: chainId, id: '1', timestamp: 200 }]
    }),
    (event) => event.timestamp,
    200
  );
  assert.deepEqual(selectedMonitorEvents().map((event) => `${event.chain}:${event.id}`), ['bsc:1', 'robinhood:1']);
});

test('mixed-chain events render chain-scoped links, notes, labels and distinct backgrounds', () => {
  const renderSource = appSourceBetween('function renderMonitorEvents()', 'function monitorEventByKey(eventKey)');
  assert.match(renderSource, /data-chain="\$\{eventChain\.id\}"/);
  assert.match(renderSource, /class="monitor-chain-badge" data-chain="\$\{eventChain\.id\}"/);
  assert.match(renderSource, /eventChain\.nativeSymbol/);
  assert.match(renderSource, /eventChain\.debotAddressRoot/);
  assert.match(renderSource, /eventChain\.debotTokenRoot/);
  assert.match(renderSource, /explorerUrlForChain\(eventChain\.id, 'tx', event\.txHash\)/);
  assert.match(renderSource, /data-monitor-note-chain="\$\{eventChain\.id\}"/);
  assert.match(appJs, /fetchMonitorSessionJson\(context, `\/wallets\/\$\{encodeURIComponent\(editor\.address\)\}`, \{[\s\S]*method: 'PATCH'/);
  assert.match(appJs, /const normalizeAddress = \(value\) => normalizeAddressForChain\(value, chainId\)/);
  assert.match(appJs, /const normalizeTransactionHash = \(value\) => normalizeTransactionHashForChain\(value, chainId\)/);

  for (const [chainId, color] of [
    ['robinhood', '#f7fcf9'],
    ['base', '#f7faff'],
    ['bsc', '#fffdf5'],
    ['solana', '#fcf9fe']
  ]) {
    assert.match(stylesCss, new RegExp(`\\.monitor-event-item\\[data-chain="${chainId}"\\] \\{[\\s\\S]*?--chain-surface: ${color}`));
    assert.match(stylesCss, new RegExp(`\\.monitor-chain-badge\\[data-chain="${chainId}"\\]`));
  }
  assert.match(stylesCss, /\.monitor-event-item\.is-profit-top-10::after \{[\s\S]*border: 2px solid #c99718/);
  assert.match(stylesCss, /\.monitor-event-item\.is-manual-alias,[\s\S]*var\(--chain-surface\)[\s\S]*#ffe8e8/);
});

test('multi-chain flow controls remain readable in the desktop half-panel and narrow mobile layouts', () => {
  assert.match(stylesCss, /\.monitor-chain-filter \{[\s\S]*display: flex[\s\S]*justify-content: flex-end/);
  assert.match(appJs, /label\.dataset\.connection = connection/);
  assert.match(appJs, /ready: '实时连接正常'/);
  assert.match(appJs, /polling: '轮询补偿中'/);
  assert.match(appJs, /error: `连接异常/);
  for (const connection of ['ready', 'polling', 'loading', 'error']) {
    assert.match(stylesCss, new RegExp(`\\.monitor-chain-filter label\\[data-selected="true"\\]\\[data-connection="${connection}"\\]::after`));
  }
  assert.match(stylesCss, /@media \(max-width: 760px\)[\s\S]*\.monitor-chain-filter \{[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(stylesCss, /@media \(max-width: 440px\)[\s\S]*\.monitor-chain-filter \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(stylesCss, /\.monitor-chain-filter label \{[\s\S]*white-space: nowrap/);
});

test('social monitoring is a personal-watchlist feed without global feed, source, or chain filters', () => {
  const socialPanelHtml = indexHtml.slice(
    indexHtml.indexOf('<section class="social-monitor-panel"'),
    indexHtml.indexOf('<section class="monitor-feed-panel"')
  );
  const socialRenderSource = appJs.slice(
    appJs.indexOf('function renderSocialFeed'),
    appJs.indexOf('function renderSocialMonitor')
  );
  assert.match(indexHtml, /id="social-monitor-panel"[^>]*aria-labelledby="social-monitor-title"/);
  assert.match(indexHtml, /id="social-monitor-title">社媒监控/);
  assert.match(indexHtml, /id="social-bridge-badge"[^>]*data-state="loading"/);
  assert.match(appJs, /bridge\.state === 'error'/);
  assert.match(appJs, /'DeBot 异常'/);
  assert.match(appJs, /'DeBot 需要重新登录'/);
  assert.match(appJs, /'REST 补漏波动'/);
  assert.match(appJs, /SOCIAL_TRANSIENT_BRIDGE_ERROR_GRACE_MS = 8_000/);
  assert.match(appJs, /SOCIAL_TRANSIENT_BRIDGE_ERROR_CATEGORIES = new Set\(\['TIMEOUT', 'NETWORK', 'DEBOT'\]\)/);
  assert.match(appJs, /state\.socialTransport === 'sse'/);
  assert.match(appJs, /'社媒实时'/);
  assert.match(appJs, /'社媒延迟'/);
  assert.match(appJs, /SOCIAL_REALTIME_HEARTBEAT_MAX_AGE_MS = 45_000/);
  assert.match(appJs, /SSE 实时推送/);
  assert.match(stylesCss, /\.social-bridge-badge\[data-state="error"\]/);
  assert.doesNotMatch(socialPanelHtml, /data-social-feed=|id="social-(?:feed-tabs|platform-filter|chain-filter|source-filter)"/);
  assert.doesNotMatch(appJs, /socialFeedTabs|socialFeedFilter|socialPlatformFilter|socialChainFilter/);
  assert.doesNotMatch(socialRenderSource, /social-(?:source|chain)-chip|socialSourceLabel/);
  for (const id of [
    'social-search',
    'social-watchlist-manager',
    'social-watchlist-form',
    'social-pairing-row',
    'social-watchlist',
    'social-feed'
  ]) {
    assert.match(indexHtml, new RegExp(`id="${id}"`));
  }
  assert.match(socialPanelHtml, /id="social-search"[^>]*placeholder="搜索账号、备注或内容"[^>]*aria-label="搜索个人社媒监控"/);
  assert.match(socialPanelHtml, /id="social-watchlist-platform"[\s\S]*value="twitter"[\s\S]*value="fomo"/);
  assert.doesNotMatch(socialPanelHtml, /value="binance"/);
  assert.match(indexHtml, /id="social-watchlist-add"[^>]*>[\s\S]*设置并加入/);
  assert.match(appJs, /accounts: pendingAccounts\.map\(\(handle\) => \(\{[\s\S]*handle,[\s\S]*platform: state\.socialPendingWatchPlatform \|\| 'twitter',[\s\S]*eventTypes,[\s\S]*note/);
  assert.doesNotMatch(socialPanelHtml, /value="(?:robinhood|base|bsc|solana)"/);
  assert.doesNotMatch(indexHtml, /id="monitor-cluster-(?:title|summary|list)"|(?:2 分钟|60 秒)同币聚合/);
  assert.match(appJs, /socialMonitorPanel: document\.querySelector\('#social-monitor-panel'\)/);
  assert.match(appJs, /function renderSocialFeed\(\)/);
  assert.match(appJs, /function socialWatchEntryForPost\(post\)[\s\S]*state\.socialWatchlist\.find/);
  assert.match(appJs, /function visibleSocialPosts\(\)[\s\S]*if \(!isEnabledPersonalSocialEvent\(post\)\) return false/);
  assert.match(appJs, /条个人动态/);
  assert.match(appJs, /暂无个人监控动态/);
  assert.match(appJs, /post\.translatedContent/);
  assert.match(appJs, /post\.contractAddresses/);
  assert.match(appJs, /post\.media/);
  assert.match(stylesCss, /\.monitor-workspace \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(stylesCss, /\.social-feed \{[\s\S]*height: min\(820px, calc\(100vh - 118px\)\)/);
  assert.match(stylesCss, /\.social-monitor-toolbar \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(stylesCss, /@media \(min-width: 961px\) and \(max-width: 1220px\)[\s\S]*\.social-monitor-toolbar \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(stylesCss, /@media \(max-width: 960px\)[\s\S]*\.monitor-workspace \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(stylesCss, /@media \(max-width: 760px\)[\s\S]*\.social-feed \{[\s\S]*height: 68svh/);
});

test('each watched account exposes behavior controls and a searchable custom note', () => {
  const eventTypes = [
    'post',
    'reply',
    'quote',
    'repost',
    'delete',
    'follow',
    'unfollow',
    'profile_name',
    'profile_avatar',
    'profile_bio'
  ];
  assert.match(indexHtml, /id="social-event-editor"[^>]*aria-labelledby="social-event-editor-title"/);
  assert.match(indexHtml, /id="social-event-editor-form"/);
  assert.match(indexHtml, /id="social-event-editor-eyebrow"/);
  assert.match(indexHtml, /id="social-event-note"[^>]*maxlength="500"[^>]*placeholder="输入该账号的备注"/);
  assert.match(indexHtml, /id="social-event-note-label"/);
  assert.match(indexHtml, /id="social-event-options"/);
  for (const eventType of eventTypes) {
    assert.match(indexHtml, new RegExp(`name="socialEventType" value="${eventType}"`));
  }
  assert.match(indexHtml, /id="social-event-select-all"[^>]*>全部选择</);
  assert.match(indexHtml, /id="social-event-clear-all"[^>]*>全部关闭</);
  assert.match(indexHtml, /id="social-event-editor-save"/);
  assert.match(indexHtml, /id="social-event-editor-save-label"/);
  assert.match(appJs, /const SOCIAL_EVENT_TYPES = Object\.freeze\(\[[\s\S]*'profile_bio'[\s\S]*\]\)/);
  assert.match(appJs, /if \(!Array\.isArray\(value\)\) return \[\.\.\.SOCIAL_EVENT_TYPES\]/);
  assert.match(appJs, /return SOCIAL_EVENT_TYPES\.filter\(\(item\) => requested\.has\(item\)\)/);
  assert.match(appJs, /function isEnabledPersonalSocialEvent\(post\)[\s\S]*const watchEntry = socialWatchEntryForPost\(post\);[\s\S]*if \(!watchEntry\) return false/);
  assert.match(appJs, /const enabled = new Set\(normalizedSocialEventTypes\(watchEntry\.eventTypes\)\);\s+return socialEventPreferenceKeys\(post\)\.some\(\(eventType\) => enabled\.has\(eventType\)\)/);
  assert.match(appJs, /data-social-watchlist-edit="\$\{id\}"/);
  assert.match(appJs, /openSocialEventEditor\(editButton\.dataset\.socialWatchlistEdit\)/);
  assert.match(appJs, /setSocialEventEditorSelection\(SOCIAL_EVENT_TYPES\)/);
  assert.match(appJs, /setSocialEventEditorSelection\(\[\]\)/);
  assert.match(appJs, /elements\.socialEventNote\.value = String\(entry\.note \|\| ''\)/);
  assert.match(appJs, /const note = elements\.socialEventNote\.value\.trim\(\)/);
  assert.match(appJs, /state\.socialEventEditorMode = 'create'/);
  assert.match(appJs, /setSocialEventEditorSelection\(SOCIAL_EVENT_TYPES\)/);
  assert.match(appJs, /const patch = mode === 'note'[\s\S]*caBark: elements\.socialEventCaBark\.checked/);
  assert.match(indexHtml, /id="social-event-ca-bark"[^>]*type="checkbox"/);
  assert.match(appJs, /entry\.caBark === true/);
  assert.match(appJs, /runSocialWrite\('PATCH', `\/watchlist\/\$\{id\}`, patch\)/);
  assert.match(appJs, /data-social-feed-note-edit="\$\{watchEntryId\}"/);
  assert.match(appJs, /openSocialEventEditor\(editButton\.dataset\.socialFeedNoteEdit, \{ noteOnly: true \}\)/);
  assert.match(appJs, /data-social-feed-watch-remove="\$\{watchEntryId\}"/);
  assert.match(appJs, /title="停止监控 @\$\{escapeHtml\(author\.handle \|\| ''\)\}"/);
  assert.match(appJs, /function removeSocialFeedAuthor\(id\)[\s\S]*window\.confirm\(`停止监控 @\$\{handle\}？该账号的动态会从主页时间线移除。`\)/);
  assert.match(appJs, /runSocialWrite\('DELETE', `\/watchlist\/\$\{numericId\}`\)/);
  assert.match(appJs, /applySocialWatchlistEntry\(payload\?\.entry \|\| \{ \.\.\.entry, desiredState: 'removed' \}\)/);
  assert.match(appJs, /removeSocialFeedAuthor\(removeButton\.dataset\.socialFeedWatchRemove\)/);
  assert.doesNotMatch(appSourceBetween('function telegramSocialPostMarkup(message)', 'function socialFeedItems()'), /data-social-feed-watch-remove/);
  assert.match(appJs, /elements\.socialEventOptions\.hidden = noteOnly/);
  assert.match(appJs, /function closeSocialEventEditor\(\{ force = false \} = \{\}\)[\s\S]*state\.socialMutationBusy && !force/);
  assert.match(appJs, /closeSocialEventEditor\(\{ force: true \}\)/);
  assert.match(appJs, /elements\.socialEventEditor\.addEventListener\('cancel',[\s\S]*event\.preventDefault\(\)/);
  assert.match(appJs, /finally \{[\s\S]*state\.socialMutationBusy = false;[\s\S]*renderSocialMonitor\(\);/);
  assert.match(appJs, /watchEntry\?\.note/);
  assert.match(appJs, /class="social-watchlist-note"[^>]*>\$\{escapeHtml\(note\)\}/);
  assert.match(appJs, /class="social-post-note"[^>]*[\s\S]*\$\{escapeHtml\(watchNote\)\}/);
  assert.match(appJs, /eventTypes\.length\s+\? `\$\{eventTypes\.length\} 项行为`\s+: '已暂停'/);
  assert.match(stylesCss, /\.social-watchlist-copy \.social-watchlist-note \{[\s\S]*overflow-wrap: anywhere;[\s\S]*text-overflow: ellipsis/);
  assert.match(stylesCss, /\.social-post-note span \{[\s\S]*overflow-wrap: anywhere;[\s\S]*-webkit-line-clamp: 2/);
  assert.match(stylesCss, /\.social-event-note-field textarea \{[\s\S]*width: 100%;[\s\S]*max-height: 180px/);
  assert.match(stylesCss, /\.social-event-options \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(stylesCss, /\.social-post-note-edit \{[\s\S]*width: 28px;[\s\S]*height: 28px/);
  assert.match(stylesCss, /\.social-post-note-edit,\s*\.social-post-watch-remove \{[\s\S]*width: 28px;[\s\S]*height: 28px;[\s\S]*flex: 0 0 28px/);
  assert.match(stylesCss, /@media \(max-width: 760px\)[\s\S]*\.social-event-options \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(stylesCss, /@media \(max-width: 760px\)[\s\S]*\.social-event-editor-actions \{[\s\S]*flex-direction: column/);

  const matchingPosts = executableVisibleSocialPosts({
    posts: [{ id: 'priority' }, { id: 'ordinary' }],
    query: '重点项目方',
    notesByPostId: {
      priority: '重点项目方，消息需要立即看',
      ordinary: '普通观察账号'
    }
  });
  assert.deepEqual(matchingPosts.map((post) => post.id), ['priority']);

  const sortByAdded = executableSortSocialWatchlistByAdded();
  assert.deepEqual(sortByAdded([
    { id: 9, handle: 'alpha', createdAt: 200 },
    { id: 4, handle: 'zulu', createdAt: 100 },
    { id: 5, handle: 'middle', createdAt: 100 }
  ]).map((entry) => entry.handle), ['zulu', 'middle', 'alpha']);
});

test('FOMO accounts edit only FOMO event types without clearing saved selections', () => {
  assert.match(indexHtml, /value="fomo_buy"[\s\S]*value="fomo_verified"/);
  assert.match(appJs, /function configureSocialEventOptions\(platform\)[\s\S]*SOCIAL_FOMO_EVENT_TYPES\.has\(input\.value\) === fomo/);
  assert.match(appJs, /function openSocialEventEditor[\s\S]*configureSocialEventOptions\(entry\.platform\);[\s\S]*setSocialEventEditorSelection\(entry\.eventTypes\)/);
  assert.match(appJs, /input\.checked = !input\.disabled && enabled\.has\(input\.value\)/);
});

test('FOMO thesis cards show DeepSeek translations and finish with a chain-specific DeBot buy link', () => {
  assert.match(appJs, /class="social-post-translation is-fomo"><b>中文翻译<\/b>/);
  assert.match(appJs, /const debotBuyUrl = ca && CHAIN_CONFIGS\[chainKey\]\?\.debotTokenRoot/);
  assert.match(appJs, /DeBot 购买<i data-lucide="shopping-cart"><\/i>/);
  assert.match(appJs, /const chainKey = \['bnb', 'bsc'\]\.includes\(rawChain\) \? 'bsc'/);
  assert.match(stylesCss, /\.social-post-translation\.is-fomo b/);
  assert.match(stylesCss, /\.social-post-translation\.is-fomo p/);
});

test('FOMO buy and sell cards show complete trade and market details with valid chain links', () => {
  assert.match(appJs, /\['fomo_buy', 'fomo_sell', 'fomo_thesis'\]\.includes\(post\.kind\)/);
  assert.match(appJs, /\['成交金额',[\s\S]*\['成交数量',[\s\S]*\['成交价',[\s\S]*\['当时市值',[\s\S]*\['24h 成交量'/);
  assert.match(appJs, /const fomoChain = chainKey === 'bsc' \? 'bnb' : chainKey/);
  assert.match(appJs, /class="fomo-contract-row"[\s\S]*escapeHtml\(ca\)/);
  assert.match(stylesCss, /\.fomo-trade-grid \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});

test('social feed validates and accurately renders relationship and profile activity from snapshots and SSE', () => {
  const eventValidationSource = appJs.slice(
    appJs.indexOf('function socialActivityIdentity'),
    appJs.indexOf('function socialPostKey')
  );
  assert.match(appJs, /const SOCIAL_EVENT_KINDS = new Set\(\[[\s\S]*'profile',[\s\S]*'fomo_buy',[\s\S]*'fomo_verified'[\s\S]*\]\)/);
  assert.match(eventValidationSource, /const expectedActor = authorHandle\.toLowerCase\(\)/);
  assert.match(eventValidationSource, /!expectedActor \|\| colon\[2\]\.toLowerCase\(\) === expectedActor/);
  assert.match(eventValidationSource, /SOCIAL_HANDLE_PATTERN\.test\(targetHandle\)/);
  assert.match(eventValidationSource, /if \(SOCIAL_ACTIVITY_KINDS\.has\(kind\)\) \{[\s\S]*SOCIAL_HANDLE_PATTERN\.test\(activity\.actorHandle\)[\s\S]*SOCIAL_HANDLE_PATTERN\.test\(activity\.targetHandle\)/);
  assert.match(eventValidationSource, /if \(kind === 'profile'\) \{[\s\S]*SOCIAL_HANDLE_PATTERN\.test\(normalizeSocialHandle\(post\?\.author\?\.handle\)\)[\s\S]*socialProfileChanges\(post\)\.length > 0/);
  assert.match(eventValidationSource, /if \(\/\^\(\?:follow\|unfollow\|profile\)\(\?:\:\|_\)\/i\.test\(externalId\)\) return false/);
  assert.match(appJs, /const actionLabel = activity\.kind === 'follow' \? '关注了' : '取消关注了'/);
  assert.match(appJs, /if \(!targetHandle\) return ''/);
  assert.match(appJs, /data-profile-change="avatar"/);
  assert.match(appJs, /<del>\$\{escapeHtml\(before \|\| '空'\)\}<\/del>/);
  assert.match(appJs, /更新了账号资料/);
  assert.equal((appJs.match(/if \(!isEnabledPersonalSocialEvent\(post\)\) continue/g) || []).length, 2);
  assert.match(appJs, /function isEnabledPersonalSocialEvent\(post\)[\s\S]*if \(!isSocialEvent\(post\)\) return false/);
  assert.match(appJs, /function visibleSocialPosts\(\)[\s\S]*if \(!isEnabledPersonalSocialEvent\(post\)\) return false/);
  assert.match(appJs, /const SOCIAL_WATCHLIST_SNAPSHOT_RETRY_MS = Object\.freeze\(\[100, 2_000, 4_000, 8_000\]\)/);
  assert.match(appJs, /socialDeferredPosts: new Map\(\)/);
  assert.match(appJs, /if \(!watchEntry\) \{[\s\S]*state\.socialDeferredPosts\.set\(key,[\s\S]*SOCIAL_DEFERRED_POST_LIMIT/);
  assert.match(appJs, /function flushDeferredSocialPosts\(\)[\s\S]*SOCIAL_DEFERRED_POST_MAX_AGE_MS[\s\S]*isEnabledPersonalSocialEvent\(deferred\.post\)/);
  assert.match(appJs, /if \(!resetCursor && normalizedChangeId !== null && normalizedChangeId < state\.socialLatestChangeId\) \{[\s\S]*return false/);
  const snapshotCoordinator = appJs.slice(
    appJs.indexOf('function applySocialSnapshot'),
    appJs.indexOf('function scheduleSocialWatchlistSnapshotRefresh')
  );
  assert.ok(snapshotCoordinator.indexOf('if (resetCursor) state.socialPosts = [];')
    < snapshotCoordinator.indexOf('state.socialWatchlist = sortSocialWatchlistByAdded'));
  assert.ok(snapshotCoordinator.indexOf('mergeSocialPosts(record.posts.map')
    < snapshotCoordinator.indexOf('flushDeferredSocialPosts();'));
  assert.match(appJs, /function scheduleSocialWatchlistSnapshotRefresh\(attempt = 0\)[\s\S]*loadSocialSnapshot\(\{ quiet: true, expectedSequence: sequence \}\)\.then\(\(loaded\)[\s\S]*scheduleSocialWatchlistSnapshotRefresh\(retryIndex \+ 1\)/);
  assert.match(appJs, /change\.entityType === 'watchlist'[\s\S]*scheduleSocialWatchlistSnapshotRefresh\(\)/);
  assert.match(appJs, /change\.entityType === 'watchlist'[\s\S]*flushDeferredSocialPosts\(\)/);
  assert.match(appJs, /if \(id !== null && id <= state\.socialLatestChangeId\) return/);
});

test('social cards show only the final browser receipt latency in milliseconds', () => {
  assert.match(appJs, /function formatSocialLatencyMs\(start, end\)/);
  assert.match(appJs, /return `\$\{sign\}\$\{Math\.abs\(difference\)\.toLocaleString\('en-US'\)\}ms`/);
  assert.match(appJs, /post\.vpsIngestedAt \?\? post\.ingestedAt \?\? post\.storedAt/);
  assert.match(appJs, /function socialChangeLatencyBaseAt\(change\)[\s\S]*monitorTimestampMs\(change\?\.createdAt\)[\s\S]*monitorTimestampMs\(post\?\.updatedAt\)[\s\S]*socialInitialLatencyBaseAt\(post\)/);
  assert.match(appJs, /firstWebReceivedAt/);
  assert.match(appJs, /latestWebReceivedAt/);
  assert.match(appJs, /webReceiptMode: 'snapshot'/);
  assert.match(appJs, /webReceiptMode: mode/);
  assert.match(appJs, /<div class="social-latency-value" aria-label="延迟">\$\{escapeHtml\(latency\)\}<\/div>/);
  assert.doesNotMatch(appJs, /首次发现|网页首次接收|本次 VPS 变更|网页载入/);
  assert.match(appJs, /function socialReferenceMarkup\(post\)/);
  assert.match(appJs, /被回复原文/);
  assert.match(appJs, /原文翻译/);
  assert.match(stylesCss, /\.social-reply-context \{/);
  assert.match(stylesCss, /\.social-latency-value \{[\s\S]*font-variant-numeric: tabular-nums/);

  const markup = executableSocialLatencyMarkup()({
    webReceiptMode: 'updated',
    latestWebLatencyBaseAt: Date.parse('2026-07-27T13:02:36.534Z'),
    latestWebReceivedAt: Date.parse('2026-07-27T13:02:36.444Z')
  });
  assert.equal(markup, '<div class="social-latency-value" aria-label="延迟">-90ms</div>');
  assert.doesNotMatch(markup, /<time|<span|21:02|网页接收|VPS/);
});

test('historical social translations are hidden when meaningful source text is Chinese-majority', () => {
  const mainHelpers = executableSocialTranslationHelpers();
  const telegramViewerHelpers = executableSocialTranslationHelpers(telegramViewerJs);
  const cases = [
    ['主要内容已经是中文，只夹一个 bullish', true],
    ['你好 this sentence is mostly English', false],
    ['中文 ok', true],
    [
      '这是中文 https://example.com/english/path '
        + '@very_long_english_handle $VERYLONGTOKEN #verylonghashtag '
        + '0xAaaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa '
        + 'So11111111111111111111111111111111111111112',
      true
    ]
  ];

  for (const [source, expected] of cases) {
    assert.equal(mainHelpers.isChineseMajoritySocialText(source), expected);
    assert.equal(telegramViewerHelpers.isChineseMajoritySocialText(source), expected);
  }
  assert.equal(
    mainHelpers.translationForDisplay('主要内容已经是中文，只夹一个 bullish', '历史中文译文'),
    ''
  );
  assert.equal(
    telegramViewerHelpers.translationForDisplay('你好 this sentence is mostly English', '你好，这句话主要是英文。'),
    '你好，这句话主要是英文。'
  );

  const renderReference = executableSocialReferenceMarkup();
  const replyMarkup = renderReference({
    kind: 'reply',
    replyContext: {
      author: { handle: 'parent_user' },
      content: '主要内容已经是中文，只夹一个 bullish',
      translatedContent: '不应显示的历史译文'
    }
  });
  assert.doesNotMatch(replyMarkup, /不应显示的历史译文|原文翻译/);

  const visible = executableVisibleSocialPosts({
    posts: [{
      id: 91,
      kind: 'post',
      content: '主要内容已经是中文，只夹一个 bullish',
      translatedContent: '只存在于旧译文的隐藏关键词'
    }],
    query: '隐藏关键词',
    notesByPostId: {}
  });
  assert.deepEqual(visible, []);

  assert.match(appJs, /socialTranslationForDisplay\(\s*rawText,[\s\S]*message\?\.translated_text \|\| message\?\.translatedText/);
  assert.match(telegramViewerJs, /translationForDisplay\(reply\.text, reply\.translatedText\)/);
  assert.match(telegramViewerJs, /translationForDisplay\(\s*messageText,[\s\S]*message\.translated_text \|\| message\.translatedText/);
});

test('reply cards keep the displayed parent, profile link and post link on one identity', () => {
  const renderReply = executableSocialReferenceMarkup();
  const matching = renderReply({
    kind: 'reply',
    target: {
      handle: 'parent_user',
      name: 'Parent User',
      url: 'https://x.com/parent_user'
    },
    replyContext: {
      externalId: '12345',
      author: { handle: 'parent_user', name: 'Parent User' },
      url: 'https://x.com/parent_user/status/12345',
      content: 'Parent post'
    }
  });
  assert.match(matching, /href="https:\/\/x\.com\/parent_user"/);
  assert.match(matching, /href="https:\/\/x\.com\/parent_user\/status\/12345"/);
  assert.match(matching, />Parent User<\/a>/);
  assert.match(matching, />@parent_user<\/span>/);

  const conflicting = renderReply({
    kind: 'reply',
    target: {
      handle: 'wrong_parent',
      name: 'Wrong Parent',
      url: 'https://x.com/wrong_parent'
    },
    replyContext: {
      externalId: '12346',
      author: { handle: 'correct_parent', name: 'Correct Parent' },
      url: 'https://x.com/correct_parent/status/12346',
      content: 'Correct parent post'
    }
  });
  assert.match(conflicting, /href="https:\/\/x\.com\/correct_parent"/);
  assert.match(conflicting, /href="https:\/\/x\.com\/correct_parent\/status\/12346"/);
  assert.match(conflicting, />Correct Parent<\/a>/);
  assert.doesNotMatch(conflicting, /wrong_parent|Wrong Parent/i);

  const mismatchedContextUrl = renderReply({
    kind: 'reply',
    target: { handle: 'wrong_parent', url: 'https://x.com/wrong_parent' },
    replyContext: {
      externalId: '12347',
      author: { handle: 'correct_parent' },
      url: 'https://x.com/other_parent/status/99999'
    }
  });
  assert.match(mismatchedContextUrl, /href="https:\/\/x\.com\/correct_parent\/status\/12347"/);
  assert.doesNotMatch(mismatchedContextUrl, /wrong_parent|other_parent|99999/i);
});

test('reply card executable markup escapes parent-controlled names and text', () => {
  const renderReply = executableSocialReferenceMarkup();
  const markup = renderReply({
    kind: 'reply',
    target: {
      handle: 'wrong_parent',
      name: '<img src=x onerror="target()">',
      url: 'javascript:target()'
    },
    replyContext: {
      externalId: '54321',
      author: {
        handle: 'safe_parent',
        name: 'Parent <script>"quoted" & \'single\'</script>'
      },
      url: 'https://x.com/safe_parent/status/54321',
      content: '<script>alert("original")</script> & text',
      translatedContent: '<img src=x onerror="translation()">'
    }
  });
  assert.match(markup, /Parent &lt;script&gt;&quot;quoted&quot; &amp; &#39;single&#39;&lt;\/script&gt;/);
  assert.match(markup, /&lt;script&gt;alert\(&quot;original&quot;\)&lt;\/script&gt; &amp; text/);
  assert.match(markup, /&lt;img src=x onerror=&quot;translation\(\)&quot;&gt;/);
  assert.doesNotMatch(markup, /<script|<img|wrong_parent|target\(\)/i);
});

test('quote cards show and search the quoted account, original, translation and safe source link', () => {
  const renderReference = executableSocialReferenceMarkup();
  const quotedPost = {
    id: 77,
    kind: 'quote',
    content: 'Commentary on the quoted post',
    author: { handle: 'monitoring_user', name: 'Monitoring User' },
    quoteContext: {
      externalId: '67890',
      author: {
        handle: 'quote_search',
        name: 'Quoted <script>"name" & \'single\'</script>'
      },
      content: '<script>alert("quoted original needle")</script> & body',
      translatedContent: '<img src=x onerror="quoteTranslation()"> 引用翻译关键词',
      url: 'javascript:quoteContext()',
      publishedAt: 123
    }
  };
  const markup = renderReference(quotedPost);
  assert.match(markup, />引用<\/span>/);
  assert.match(markup, /href="https:\/\/x\.com\/quote_search"/);
  assert.match(markup, /href="https:\/\/x\.com\/quote_search\/status\/67890"/);
  assert.match(markup, /Quoted &lt;script&gt;&quot;name&quot; &amp; &#39;single&#39;&lt;\/script&gt;/);
  assert.match(markup, />@quote_search<\/span>/);
  assert.match(markup, /被引用原文/);
  assert.match(markup, /&lt;script&gt;alert\(&quot;quoted original needle&quot;\)&lt;\/script&gt; &amp; body/);
  assert.match(markup, /原文翻译/);
  assert.match(markup, /&lt;img src=x onerror=&quot;quoteTranslation\(\)&quot;&gt; 引用翻译关键词/);
  assert.doesNotMatch(markup, /<script|<img|javascript:/i);

  const searchablePost = {
    ...quotedPost,
    quoteContext: {
      ...quotedPost.quoteContext,
      author: { handle: 'quote_search', name: 'Quoted Search Account' },
      content: 'Quoted original needle',
      translatedContent: '引用翻译关键词'
    }
  };
  const unrelatedPost = {
    id: 78,
    kind: 'post',
    content: 'Unrelated post',
    author: { handle: 'someone_else', name: 'Someone Else' }
  };
  for (const query of ['quote_search', 'quoted search account', 'original needle', '引用翻译']) {
    const visible = executableVisibleSocialPosts({
      posts: [searchablePost, unrelatedPost],
      query,
      notesByPostId: {}
    });
    assert.deepEqual(visible.map((post) => post.id), [77]);
  }
});

test('social media markup renders safe main images without nesting its grid wrapper', () => {
  const renderMedia = executableSocialMediaMarkup();
  const markup = renderMedia([
    {
      type: 'image',
      url: 'https://pbs.twimg.com/media/first.jpg?name=orig&format=jpg'
    },
    {
      type: 'photo',
      previewUrl: 'https://pbs.twimg.com/media/second.jpg?name=small'
    },
    {
      type: 'image',
      url: 'javascript:alert(1)',
      previewUrl: 'data:image/svg+xml,<svg onload=alert(2)>'
    }
  ], {
    postUrl: 'https://x.com/example/status/12345?view=1&source=radar',
    altPrefix: '推文图片'
  });

  assert.equal((markup.match(/class="social-post-media/g) || []).length, 1);
  assert.equal((markup.match(/class="social-media-item"/g) || []).length, 2);
  assert.match(markup, /class="social-post-media" data-media-count="2"/);
  assert.match(markup, /src="https:\/\/pbs\.twimg\.com\/media\/first\.jpg\?name=orig&amp;format=jpg"/);
  assert.match(markup, /src="https:\/\/pbs\.twimg\.com\/media\/second\.jpg\?name=small"/);
  assert.match(markup, /alt="推文图片 1"/);
  assert.match(markup, /loading="lazy" decoding="async" referrerpolicy="no-referrer"/);
  assert.match(markup, /href="https:\/\/x\.com\/example\/status\/12345\?view=1&amp;source=radar"/);
  assert.doesNotMatch(markup, /javascript:|data:image|onload=|<div class="social-post-media[^>]*>[\s\S]*<div class="social-post-media/i);

  const renderSource = appSourceBetween('function renderSocialFeed()', 'function renderSocialMonitor()');
  assert.match(renderSource, /const mediaMarkup = socialMediaMarkup\(media,/);
  assert.match(renderSource, /\$\{!nonPostActivity \? mediaMarkup : ''\}/);
  assert.doesNotMatch(renderSource, /<div class="social-post-media">\$\{mediaMarkup\}<\/div>/);
});

test('social media markup gives playable videos a poster and degrades preview-only videos to images', () => {
  const renderMedia = executableSocialMediaMarkup();
  const markup = renderMedia([
    {
      type: 'video',
      previewUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/poster.jpg?name=large'
    },
    {
      type: 'video',
      url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/1280x720/video.mp4?tag=12&v=1',
      previewUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/poster.jpg?name=large'
    },
    {
      type: 'video',
      previewUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/456/pu/img/preview.jpg?name=large'
    }
  ], {
    postUrl: 'https://x.com/example/status/67890'
  });

  assert.equal((markup.match(/<video\b/g) || []).length, 1);
  assert.match(markup, /data-media-count="2"/);
  assert.match(markup, /<video data-lazy-social-video data-src="https:\/\/video\.twimg\.com\/[^\"]+video\.mp4\?tag=12&amp;v=1"/);
  assert.match(markup, /preload="none"/);
  assert.match(markup, /poster="https:\/\/pbs\.twimg\.com\/[^\"]+poster\.jpg\?name=large"/);
  assert.match(markup, /controls preload="none" playsinline referrerpolicy="no-referrer"/);
  assert.match(markup, /class="social-media-video-poster"[\s\S]*alt="推文视频封面 1"/);
  assert.match(markup, /data-media-kind="video-preview"[\s\S]*<img src="https:\/\/pbs\.twimg\.com\/[^\"]+preview\.jpg\?name=large"/);
  assert.doesNotMatch(markup, /<video[^>]+src="https:\/\/pbs\.twimg\.com/);
  assert.equal((markup.match(/媒体加载失败，查看原文/g) || []).length, 2);
  assert.match(markup, /href="https:\/\/x\.com\/example\/status\/67890"/);
});

test('reply and quote contexts render their own escaped media grids', () => {
  const renderReference = executableSocialReferenceMarkup();
  const replyMarkup = renderReference({
    kind: 'reply',
    replyContext: {
      externalId: '12345',
      author: { handle: 'parent_user', name: 'Parent User' },
      content: 'Parent post',
      media: [{
        type: 'image',
        url: 'https://pbs.twimg.com/media/reply.jpg?name=orig&source=reply'
      }]
    }
  });
  const quoteMarkup = renderReference({
    kind: 'quote',
    quoteContext: {
      externalId: '67890',
      author: { handle: 'quote_user', name: 'Quote User' },
      content: 'Quoted post',
      media: [{
        type: 'video',
        previewUrl: 'https://pbs.twimg.com/media/quote-preview.jpg?name=large&source=quote'
      }]
    }
  });

  assert.equal((replyMarkup.match(/class="social-post-media is-context"/g) || []).length, 1);
  assert.match(replyMarkup, /alt="被回复原文图片 1"/);
  assert.match(replyMarkup, /reply\.jpg\?name=orig&amp;source=reply/);
  assert.equal((quoteMarkup.match(/class="social-post-media is-context"/g) || []).length, 1);
  assert.match(quoteMarkup, /data-reference-kind="quote"/);
  assert.match(quoteMarkup, /data-media-kind="video-preview"/);
  assert.match(quoteMarkup, /alt="被引用原文图片 1"/);
  assert.match(quoteMarkup, /quote-preview\.jpg\?name=large&amp;source=quote/);
});

test('social media CSS provides bounded responsive grids and a visible load-error fallback', () => {
  assert.match(stylesCss, /\.social-post-media \{[\s\S]*display: grid;[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[\s\S]*width: min\(100%, 680px\);[\s\S]*overflow: hidden/);
  assert.match(stylesCss, /\.social-media-item \{[\s\S]*min-width: 0;[\s\S]*aspect-ratio: 4 \/ 3;[\s\S]*overflow: hidden/);
  assert.match(stylesCss, /\.social-media-preview,[\s\S]*\.social-media-item img,[\s\S]*\.social-media-item video \{[\s\S]*width: 100%;[\s\S]*height: 100%/);
  assert.match(stylesCss, /\.social-media-item\.is-error \.social-media-error \{[\s\S]*display: flex/);
  assert.match(stylesCss, /\.social-media-item\.is-video-error \.social-media-video-poster \{[\s\S]*display: block/);
  assert.match(stylesCss, /\.social-post-media\.is-context \{[\s\S]*width: min\(100%, 520px\)/);
  assert.match(appJs, /elements\.socialFeed\.addEventListener\('error',[\s\S]*event\.target instanceof HTMLVideoElement[\s\S]*classList\.add\('is-video-error'\)[\s\S]*classList\.add\('is-error'\)/);
});

test('chain and social elapsed times advance every second without rerendering either feed', () => {
  const formatterSource = appJs.slice(
    appJs.indexOf('function formatMonitorAge'),
    appJs.indexOf('function normalizeTransactionHash(value)')
  );
  assert.match(formatterSource, /function formatMonitorAge\(value, now = Date\.now\(\)\)/);
  assert.match(formatterSource, /Math\.floor\(\(now - timestamp\) \/ 1000\)/);
  assert.match(formatterSource, /if \(seconds < 60\) return `\$\{seconds\} 秒前`/);
  assert.match(formatterSource, /String\(seconds % 60\)\.padStart\(2, '0'\)/);
  assert.match(formatterSource, /if \(minutes < 60\) return `\$\{minutes\} 分钟 \$\{remainingSeconds\} 秒前`/);
  assert.match(formatterSource, /return `\$\{hours\} 小时 \$\{remainingMinutes\} 分钟 \$\{remainingSeconds\} 秒前`/);
  assert.doesNotMatch(formatterSource, /刚刚';|formatDateTime\(timestamp\)/);
  assert.match(appJs, /<time class="social-post-time"[^>]*data-live-timestamp="\$\{escapeHtml\(String\(post\.publishedAt \?\? ''\)\)\}"[^>]*aria-live="off"/);
  assert.match(appJs, /<time datetime="\$\{escapeHtml\(String\(eventTime \?\? ''\)\)\}" data-live-timestamp="\$\{escapeHtml\(String\(eventTime \?\? ''\)\)\}"[^>]*aria-live="off"/);

  const updaterSource = appJs.slice(
    appJs.indexOf('function updateLiveRelativeTimes'),
    appJs.indexOf('function normalizeTransactionHash(value)')
  );
  assert.match(updaterSource, /document\.querySelectorAll\('time\[data-live-timestamp\]'\)/);
  assert.match(updaterSource, /const label = formatMonitorAge\(time\.dataset\.liveTimestamp, now\);\s+if \(time\.textContent !== label\) time\.textContent = label/);
  assert.match(updaterSource, /renderMonitorHealth\(\)/);
  assert.match(updaterSource, /renderSocialBridgeStatus\(\)/);
  assert.doesNotMatch(updaterSource, /renderMonitorEvents\(|renderSocialFeed\(|renderSocialMonitor\(|innerHTML/);

  const tickSource = appJs.slice(
    appJs.indexOf('state.monitorTickTimer = setInterval'),
    appJs.indexOf('void startSocialMonitor({ manual })')
  );
  assert.match(tickSource, /synchronizeMonitorAlerts\(\);\s+updateLiveRelativeTimes\(\);\s+}, 1_000\)/);
  assert.doesNotMatch(tickSource, /renderMonitorEvents\(|renderSocialFeed\(|renderSocialMonitor\(|innerHTML/);
  const monitorStartSource = appSourceBetween('async function startMonitorPage(', 'async function updateMonitorFeedChainSelection(');
  assert.ok(
    monitorStartSource.indexOf('state.monitorTickTimer = setInterval') < monitorStartSource.indexOf('await synchronizeMonitorSessions'),
    'the live UI clock must start before the initial monitor sessions'
  );
  assert.match(appJs, /function applySocialBridgeStatus\(bridge\)[\s\S]*state\.socialBridgeObservedAt = performance\.now\(\)/);
  assert.match(appJs, /const reportedHeartbeatAgeMs = finiteNumber\(bridge\.heartbeatAgeMs\);[\s\S]*performance\.now\(\) - bridgeObservedAt[\s\S]*reportedHeartbeatAgeMs \+ elapsedSinceObservationMs/);
  assert.match(appJs, /function refreshVisibleRealtimeState\(\)[\s\S]*updateVisibleLiveRelativeTimes\(\)[\s\S]*void loadSocialStatus\(state\.socialSequence\)/);
  assert.match(appJs, /document\.addEventListener\('visibilitychange', refreshVisibleRealtimeState\)/);
  assert.match(appJs, /window\.addEventListener\('focus', refreshVisibleRealtimeState\)/);
  assert.match(appJs, /window\.addEventListener\('online', refreshVisibleRealtimeState\)/);
  assert.match(appJs, /window\.addEventListener\('pageshow', \(event\) => \{[\s\S]*event\.persisted[\s\S]*void startMonitorPage\(\)/);
  assert.match(stylesCss, /\.social-post-time \{[\s\S]*font-variant-numeric: tabular-nums/);
  assert.match(stylesCss, /\.social-post-time \{[\s\S]*white-space: normal/);
  assert.match(stylesCss, /\.monitor-event-item time \{[\s\S]*white-space: normal/);
});

test('realtime feeds cap live DOM and reconcile stable cards instead of replacing whole lists', () => {
  assert.match(appJs, /const MONITOR_FEED_EVENT_LIMIT = 100;/);
  assert.match(appJs, /const SOCIAL_FEED_RENDER_LIMIT = 80;/);
  assert.match(telegramMonitorJs, /const TELEGRAM_MESSAGE_LIMIT = 100;/);

  const helperSource = appSourceBetween('function stableFeedFingerprint(markup)', 'function renderSocialBridgeStatus()');
  assert.match(helperSource, /function reconcileKeyedFeed\(container, markup\)/);
  assert.match(helperSource, /current\?\.dataset\.feedFingerprint === candidate\.dataset\.feedFingerprint/);
  assert.match(helperSource, /for \(const obsolete of existing\.values\(\)\) obsolete\.remove\(\)/);

  const socialRenderSource = appSourceBetween('function renderSocialFeed()', 'function renderSocialMonitor()');
  assert.match(socialRenderSource, /reconcileKeyedFeed\(elements\.socialFeed, markup\)/);
  assert.doesNotMatch(socialRenderSource, /elements\.socialFeed\.innerHTML = items\.map/);

  const monitorRenderSource = appSourceBetween('function renderMonitorEvents()', 'function monitorEventByKey(eventKey)');
  assert.match(monitorRenderSource, /reconcileKeyedFeed\(elements\.monitorEventFeed, markup\)/);
  assert.doesNotMatch(monitorRenderSource, /elements\.monitorEventFeed\.innerHTML = events\.map/);
});

test('social snapshot and SSE lifecycle stay pinned to the Robinhood host service', () => {
  assert.match(appJs, /const APP_BASE = \/\^\\\/robinhood-radar\(\?:\\\/\|\$\)\/\.test\(window\.location\.pathname\)/);
  assert.match(appJs, /const SOCIAL_API_ROOT = `\$\{APP_BASE\}\/api\/social`/);
  assert.match(appJs, /fetchJson\(`\$\{SOCIAL_API_ROOT\}\?postLimit=100`, \{ signal: controller\.signal \}\)/);
  assert.match(appJs, /fetchJson\(`\$\{SOCIAL_API_ROOT\}\/status`, \{ signal: controller\.signal \}\)/);
  assert.match(appJs, /new EventSource\(`\$\{SOCIAL_API_ROOT\}\/stream\?after=\$\{encodeURIComponent\(state\.socialLatestChangeId\)\}&epoch=\$\{encodeURIComponent\(state\.socialStreamEpoch\)\}`\)/);
  for (const eventType of ['snapshot', 'reset', 'heartbeat', 'post.created', 'post.updated', 'post.deleted', 'post.restored', 'watchlist.updated']) {
    assert.equal(appJs.includes(`'${eventType}'`), true, `missing social SSE event ${eventType}`);
  }
  assert.match(appJs, /function socialLifecycleIsCurrent\(sequence\)/);
  assert.match(appJs, /state\.socialSnapshotAbortController\?\.abort\(\)/);
  assert.match(appJs, /source\.close\(\);[\s\S]{0,180}scheduleSocialReconnect\(sequence\)/);
  assert.match(appJs, /state\.socialTransport = 'reconnecting'/);
  assert.match(appJs, /state\.socialTransport = 'sse'/);
  assert.match(appJs, /clearTimeout\(state\.socialReconnectTimer\)/);
  assert.match(appJs, /clearInterval\(state\.socialStatusTimer\)/);
  assert.match(appJs, /void startSocialMonitor\(\{ manual \}\)/);
  assert.match(appJs, /function stopMonitorTransport\(\{ stopSocial = true, clearEvents = false \} = \{\}\)[\s\S]*if \(stopSocial\) stopSocialMonitor\(\)/);
  assert.match(appJs, /if \(!preserveSocial \|\| !state\.socialStarted\) void startSocialMonitor\(\{ manual \}\)/);
  assert.match(appJs, /state\.socialLatestChangeId = resetCursor\s+\? normalizedChangeId\s+: Math\.max\(state\.socialLatestChangeId, normalizedChangeId\)/);
  assert.match(appJs, /applySocialSnapshot\(parseSocialStreamEvent\(event\), \{ resetCursor: true \}\)/);
  assert.match(appJs, /const SOCIAL_STATUS_REFRESH_MS = 2_000/);
  assert.match(appJs, /const SOCIAL_STATUS_TIMEOUT_MS = 3_000/);
  assert.match(appJs, /const SOCIAL_SNAPSHOT_TIMEOUT_MS = 5_000/);
  assert.match(appJs, /const SOCIAL_STREAM_RETRY_INITIAL_MS = 250/);
  assert.match(appJs, /const SOCIAL_STREAM_RETRY_MAX_MS = 2_000/);
  assert.match(appJs, /const delay = Math\.min\([\s\S]*SOCIAL_STREAM_RETRY_INITIAL_MS \* \(2 \*\* state\.socialReconnectAttempt\)[\s\S]*SOCIAL_STREAM_RETRY_MAX_MS/);
  const socialStartSource = appJs.slice(
    appJs.indexOf('function startSocialMonitor'),
    appJs.indexOf('function stopSocialMonitor')
  );
  assert.ok(
    socialStartSource.indexOf('connectSocialStream(sequence);')
      < socialStartSource.indexOf('void loadSocialSnapshot({ quiet: !manual, expectedSequence: sequence });'),
    'SSE must start before the initial snapshot request'
  );
  assert.match(appJs, /state\.socialStatusAbortController\?\.abort\(\)/);
  assert.match(appJs, /const SOCIAL_STREAM_STALE_MS = 35_000/);
  assert.match(appJs, /if \(!socialStreamIsRecent\(\)\) state\.socialConnected = false/);
  assert.match(appJs, /Math\.trunc\(remoteLatestChangeId\) > state\.socialLatestChangeId/);
  assert.match(appJs, /if \(missedChanges \|\| cursorMovedBack \|\| streamEpochChanged \|\| streamIsSilent\) \{\s+recoverSocialStream\(expectedSequence, remoteLatestChangeId\)/);
  assert.match(appJs, /function recoverSocialStream\(sequence, remoteLatestChangeId = state\.socialLatestChangeId\)/);
  assert.match(appJs, /state\.socialRecoveryBusy[\s\S]{0,180}recoveryAgeMs < SOCIAL_RECOVERY_RETRY_MS \|\| streamActivityAgeMs < SOCIAL_RECOVERY_RETRY_MS/);
  assert.match(appJs, /source\.addEventListener\('heartbeat'/);
  assert.doesNotMatch(appJs, /state\.socialReconnectTimer = setTimeout\(async \(\) => \{[\s\S]{0,240}loadSocialSnapshot/);
  assert.match(appJs, /state\.socialExtensionReady = message\.configured === true/);
  assert.match(appJs, /state\.socialExtensionWritable = message\.writable === true/);
  assert.doesNotMatch(appJs, /LEGACY_RADAR_ORIGIN|CANONICAL_RADAR_ORIGIN|217\.116\.171\.250|sslip\.io/);
  assert.match(appJs, /if \(!SOCIAL_WRITE_CONTEXT_ALLOWED\) throw new Error\('请通过 HTTPS 页面修改社媒监控名单'\)/);
  assert.match(appJs, /if \(state\.socialExtensionReady && state\.socialExtensionWritable\) \{\s+return requestSocialExtension/);
  assert.match(appJs, /window\.localStorage\.removeItem\(SOCIAL_DEVICE_TOKEN_STORAGE_KEY\)/);
  assert.match(appJs, /authorization: `Bearer \$\{token\}`/);
});

test('same-token alerts remain active as background logic after their panel is removed', () => {
  assert.match(appJs, /function formatMonitorWindowDuration\(value = state\.monitorWindowSeconds\)/);
  assert.match(appJs, /elements\.monitorWindowDescription\.textContent = `已确认地址 · 金额不限 · \$\{windowLabel\}滚动窗口`/);
  assert.match(appJs, /elements\.monitorThresholdLabel\.textContent = `\$\{windowLabel\}同币提醒人数`/);
  assert.match(appJs, /state\.monitorWindowSeconds\) \* 1000/);
  assert.match(appJs, /if \(!cluster\.wallets\.has\(event\.walletAddress\)\) cluster\.wallets\.set/);
  assert.match(appJs, /walletCount: cluster\.wallets\.size/);
  assert.match(appJs, /if \(cluster\.walletCount < state\.monitorThreshold\) continue/);
  assert.match(appJs, /if \(!session\.alertedTokens\.has\(cluster\.key\)\)/);
  assert.match(appJs, /Array\.isArray\(record\.alertedTokenAddresses\)/);
  assert.match(appJs, /session\.alertedTokens\.add\(`\$\{session\.chainId\}:\$\{normalized\}`\)/);
  assert.match(appJs, /synchronizeMonitorAlerts\(\{[\s\S]*playNew: !initial && added\.length > 0,[\s\S]*sessions: \[session\]/);
  assert.match(appJs, /\[\.\.\.state\.monitorFeedChainIds\]\.map\(\(chainId\) => monitorSession\(chainId, \{ create: false \}\)\)/);
  assert.match(appJs, /filter\(\(session\) => session && state\.monitorFeedChainIds\.has\(session\.chainId\)\)/);
  assert.doesNotMatch(appJs, /monitorAlertedTokens\.delete/);
  assert.match(appJs, /playNew && state\.monitorSoundEnabled/);
});

test('generic wallet events support native transfers, event metadata and safe links', () => {
  assert.match(indexHtml, /id="monitor-page-title">实时链上监控</);
  assert.match(indexHtml, /id="monitor-feed-title">实时链上流水</);
  assert.match(indexHtml, /等待钱包动态/);
  assert.match(appJs, /pick\(\['eventType', 'event_type', 'type'\], 'buy'\)/);
  assert.match(appJs, /recipient: normalizeAddress\(pick\(\[[\s\S]*'counterpartyAddress'[\s\S]*'to'/);
  assert.match(appJs, /platform: String\(pick\(\['platform', 'protocol', 'dex', 'source'\]/);
  assert.match(appJs, /if \(!event\.walletAddress\) continue/);
  assert.match(appJs, /if \(event\.eventType !== 'buy'\) continue/);
  assert.match(appJs, /event\.tokenAddress[\s\S]*\? safeHttpUrl\(event\.debotTokenUrl\)[\s\S]*: ''/);
  assert.match(appJs, /接收方 \$\{escapeHtml\(recipientLabel\)\}/);
  assert.match(appJs, /function monitorPlatformLabel\(value\)/);
  assert.match(appJs, /if \(value === 'four_meme'\) return 'Four\.meme';/);
  assert.match(appJs, /平台 \$\{escapeHtml\(monitorPlatformLabel\(event\.platform\)\)\}/);
  assert.match(appJs, /Noxa 发币[^\n]+Four\.meme 发币[^\n]+直接部署/);
  for (const [eventType, label] of [['buy', '买入'], ['sell', '卖出'], ['transfer', '转账'], ['token_create', '创建代币']]) {
    assert.equal(appJs.includes(`${eventType}: '${label}'`), true, `missing monitor event label ${eventType}`);
    assert.match(stylesCss, new RegExp(`\\.monitor-event-type\\.${eventType.replace('_', '_')}`));
  }
  const mergeSource = appJs.slice(appJs.indexOf('function mergeMonitorEvents'), appJs.indexOf('function computedMonitorClusters'));
  assert.doesNotMatch(mergeSource, /!event\.tokenAddress/);
  assert.match(stylesCss, /\.monitor-event-meta span \{[\s\S]*text-overflow: ellipsis/);
});

test('real-time token events upsert asynchronous market cap and token-age enrichment', () => {
  assert.match(appJs, /marketCapUsd: pickNumber\(\['marketCapUsd', 'market_cap_usd'\]\)/);
  assert.match(appJs, /tokenCreationTimestamp: pick\(\['tokenCreationTimestamp', 'token_creation_timestamp'\], null\)/);
  assert.match(appJs, /marketDataAt: pick\(\['marketDataAt', 'market_data_at'\], null\)/);
  const mergeSource = appJs.slice(appJs.indexOf('function mergeMonitorEvents'), appJs.indexOf('function markMonitorEventsFresh'));
  assert.match(mergeSource, /indexesByKey\.get\(key\)/);
  assert.match(mergeSource, /normalizeMonitorEvent\(rawEvent, session\.events\[existingIndex\], session\.chainId\)/);
  assert.doesNotMatch(mergeSource, /state\.monitorEventKeys\.has\(key\)[^\n]+continue/);
  assert.match(appJs, /source\.addEventListener\('event_update', \(event\) => \{[\s\S]*if \(isCurrentSource\(\)\) applyMonitorStreamEventUpdate\(event, session\)/);
  assert.match(appJs, /eventIds\.map\(\(id\) => \(\{ \.\.\.scopedSource, id \}\)\)/);
  assert.match(appJs, /formatMonitorMarketCap\(event\.marketCapUsd\)/);
  assert.match(appJs, /monitorTimestampMs\(event\?\.blockTimestamp\)[\s\S]*monitorTimestampMs\(event\?\.tokenCreationTimestamp\)/);
  assert.match(appJs, /<dt>发现时市值<\/dt>/);
  assert.match(appJs, /event\.eventType === 'buy' \? '买入时币龄' : '事件时币龄'/);
  assert.match(appJs, /marketCap === null \? '待获取'/);
  assert.match(appJs, /tokenAge !== '待获取'/);
});

test('real-time buys show the first two monitored buyers and hide suppressed stock buys', () => {
  assert.match(appJs, /earliestBuyers:[\s\S]*slice\(0, 2\)/);
  assert.match(appJs, /<dt>最早买入<\/dt>/);
  assert.match(appJs, /monitor-earliest-buyers/);
  assert.match(appJs, /filter\(\(event\) => event\.suppressed !== true\)/);
  assert.match(stylesCss, /\.monitor-event-metrics \{[\s\S]*grid-template-columns: repeat\(3,/);
});

test('Robinhood token risk enrichment is progressive, nullable and isolated from other chains', () => {
  const normalizeSource = appSourceBetween('function normalizeMonitorEvent(raw, current = null, fallbackChainId = activeChainId)', 'function generatedWalletProfitPosition(');
  assert.match(normalizeSource, /const pickBoolean = \(keys\) => nullableBoolean\(pickPresent\(keys, null\)\)/);
  const normalizeBoolean = Function(`${appSourceBetween('function nullableBoolean(value)', 'function firstValue(source, keys, fallback = null)')}\nreturn nullableBoolean;`)();
  assert.equal(normalizeBoolean(false), false);
  assert.equal(normalizeBoolean(true), true);
  assert.equal(normalizeBoolean(0), null);
  for (const field of [
    ['tokenRiskStatus', 'token_risk_status'],
    ['liquidityUsd', 'liquidity_usd'],
    ['top10HolderPercent', 'top10_holder_percent'],
    ['creatorHoldingPercent', 'creator_holding_percent'],
    ['canMintMore', 'can_mint_more'],
    ['creatorTokenCount', 'creator_token_count'],
    ['creatorDeadTokenCount', 'creator_dead_token_count'],
    ['creatorHistoryPartial', 'creator_history_partial'],
    ['deadDefinition', 'dead_definition'],
    ['tokenRiskDataAt', 'token_risk_data_at'],
    ['tokenRiskError', 'token_risk_error'],
    ['tokenRiskFlags', 'token_risk_flags']
  ]) {
    assert.match(normalizeSource, new RegExp(`${field[0]}[\\s\\S]{0,100}${field[1]}`));
  }
  assert.match(normalizeSource, /sellable: pickBoolean\(\['sellable'\]\)/);
  assert.match(normalizeSource, /canMintMore: pickBoolean\(\['canMintMore', 'can_mint_more'\]\)/);

  const renderRobinhoodRisk = executableRenderMonitorTokenRisk();
  const readyMarkup = renderRobinhoodRisk({
    tokenAddress: '0x0000000000000000000000000000000000000001',
    assetType: 'token',
    tokenRiskStatus: 'ready',
    sellable: false,
    liquidityUsd: 42_000,
    top10HolderPercent: 1,
    creatorHoldingPercent: 0,
    canMintMore: false,
    creatorTokenCount: 0,
    creatorDeadTokenCount: 0,
    tokenRiskFlags: []
  });
  assert.match(readyMarkup, /data-status="ready"/);
  assert.match(readyMarkup, /data-metric="sellable" data-state="danger"[\s\S]*疑似不可卖/);
  assert.match(readyMarkup, /流动性[\s\S]*\$42K/);
  assert.match(readyMarkup, /前10占比[\s\S]*<dd>1%<\/dd>/);
  assert.doesNotMatch(readyMarkup, /100%/);
  assert.match(readyMarkup, /创建者持仓[\s\S]*<dd>0%<\/dd>/);
  assert.match(readyMarkup, /data-metric="mintable" data-state="safe"[\s\S]*未发现增发/);
  assert.doesNotMatch(readyMarkup, /不可增发/);
  assert.match(readyMarkup, /0币 \/ 0个归零/);

  const recentSalesMarkup = renderRobinhoodRisk({
    tokenAddress: '0x0000000000000000000000000000000000000001',
    assetType: 'token',
    tokenRiskStatus: 'ready',
    sellable: true,
    tokenRiskFlags: ['sellability_recent_sales_only']
  });
  assert.match(recentSalesMarkup, /data-metric="sellable" data-state="ready"[\s\S]*近期有卖出/);
  assert.doesNotMatch(recentSalesMarkup, />可卖出</);

  const confirmedSellableMarkup = renderRobinhoodRisk({
    tokenAddress: '0x0000000000000000000000000000000000000001',
    assetType: 'token',
    tokenRiskStatus: 'ready',
    sellable: true,
    tokenRiskFlags: []
  });
  assert.match(confirmedSellableMarkup, /data-metric="sellable" data-state="safe"[\s\S]*>可卖出</);
  assert.doesNotMatch(confirmedSellableMarkup, /近期有卖出/);

  const partialHistoryMarkup = renderRobinhoodRisk({
    tokenAddress: '0x0000000000000000000000000000000000000001',
    assetType: 'token',
    tokenRiskStatus: 'ready',
    creatorTokenCount: 8,
    creatorDeadTokenCount: 6,
    creatorHistoryPartial: true,
    deadDefinition: 'age>=24h && (no_pair || liquidity<1000)'
  });
  assert.match(partialHistoryMarkup, /≥8币 \/ ≥6个归零/);
  assert.match(partialHistoryMarkup, /data-metric="creator-history"[\s\S]*title="归零口径：/);
  assert.match(partialHistoryMarkup, /当前历史仅代表已发现下限，实际发币和归零数量可能更高/);
  assert.match(partialHistoryMarkup, /服务端口径：age&gt;=24h &amp;&amp; \(no_pair \|\| liquidity&lt;1000\)/);

  assert.match(renderRobinhoodRisk({ tokenAddress: '0x1', assetType: 'token', tokenRiskStatus: 'pending' }), /风险分析中/);
  assert.match(renderRobinhoodRisk({ tokenAddress: '0x1', assetType: 'token', tokenRiskStatus: 'partial' }), /data-status="partial"[\s\S]*卖出待验证/);
  assert.match(renderRobinhoodRisk({ tokenAddress: '0x1', assetType: 'token', tokenRiskStatus: 'unavailable' }), /暂无风险数据/);
  assert.match(renderRobinhoodRisk({ tokenAddress: '0x1', assetType: 'token', tokenRiskStatus: 'error' }), /风险资料获取失败/);
  assert.equal(renderRobinhoodRisk({ tokenAddress: '0x1', assetType: 'native', tokenRiskStatus: 'ready' }), '');
  assert.equal(executableRenderMonitorTokenRisk('base')({ tokenAddress: '0x1', assetType: 'token', tokenRiskStatus: 'ready' }), '');
  assert.equal(executableRenderMonitorTokenRisk('base')({
    tokenAddress: '0x1',
    assetType: 'token',
    tokenRiskStatus: 'ready',
    creatorTokenCount: 8,
    creatorDeadTokenCount: 6,
    creatorHistoryPartial: true
  }), '');
  assert.equal(executableRenderMonitorTokenRisk('bsc')({
    tokenAddress: '0x1',
    assetType: 'token',
    tokenRiskStatus: 'ready'
  }), '');
  assert.equal(executableRenderMonitorTokenRisk('solana')({ tokenAddress: 'mint', assetType: 'token', tokenRiskStatus: 'ready' }), '');

  const renderSource = appSourceBetween('function normalizedMonitorRiskPercent(value)', 'function monitorPlatformLabel(value)');
  assert.match(renderSource, /monitorChainId\(event\?\.chain\) !== 'robinhood'/);
  assert.doesNotMatch(renderSource, /\bfetch\s*\(/);
  assert.match(stylesCss, /\.monitor-token-risk \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(stylesCss, /@media \(max-width: 760px\)[\s\S]*\.monitor-token-risk \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  const riskStyles = stylesCss.slice(stylesCss.indexOf('.monitor-token-risk,'), stylesCss.indexOf('.monitor-event-links {'));
  assert.doesNotMatch(riskStyles, /background(?:-color)?\s*:|border-radius\s*:/);
});

test('real-time feed distinguishes proven top-profit buyers and manually named wallets', () => {
  const normalizeSource = appJs.slice(
    appJs.indexOf('function normalizeMonitorEvent'),
    appJs.indexOf('function monitorEventTimestamp')
  );
  assert.match(normalizeSource, /walletAliasSource.*wallet_alias_source/);
  assert.match(normalizeSource, /walletCustomAlias.*wallet_custom_alias/);

  const rankSource = appJs.slice(
    appJs.indexOf('function generatedWalletProfitPosition'),
    appJs.indexOf('function monitorEventTimestamp')
  );
  assert.match(rankSource, /aliasSource[\s\S]*!== 'generated'/);
  assert.match(rankSource, /\^\(\.\+\?\)\\s\+\(10\|\[1-9\]\)\$/);
  assert.match(rankSource, /tokenSymbol: match\[1\]\.trim\(\), rank: Number\(match\[2\]\)/);
  const position = executableGeneratedWalletProfitPosition();
  assert.deepEqual(position('AI 5', 'generated'), { tokenSymbol: 'AI', rank: 5 });
  assert.deepEqual(position('VIBE CAT 10', 'generated'), { tokenSymbol: 'VIBE CAT', rank: 10 });
  assert.equal(position('AI 11', 'generated'), null);
  assert.equal(position('AI 5', 'manual'), null);
  assert.equal(position('没有排名', 'generated'), null);

  const renderSource = appJs.slice(
    appJs.indexOf('function renderMonitorEvents'),
    appJs.indexOf('function monitorEventByKey')
  );
  assert.match(renderSource, /eventType === 'buy'[\s\S]*generatedWalletProfitPosition\(walletLabel, aliasSource\)/);
  assert.match(renderSource, /is-profit-top-10/);
  assert.match(renderSource, /data-profit-rank/);
  assert.match(renderSource, /monitor-profit-rank-badge/);
  assert.match(renderSource, /data-lucide="trophy"/);
  assert.match(renderSource, /is-manual-alias/);
  assert.match(renderSource, /data-manual-alias="true"/);

  assert.match(stylesCss, /\.monitor-event-item\.is-profit-top-10::after \{[\s\S]*border: 2px solid #c99718/);
  assert.match(stylesCss, /\.monitor-event-item\.is-manual-alias,[\s\S]*background: color-mix\(in srgb, var\(--chain-surface\)/);
  assert.match(stylesCss, /\.monitor-event-meta \.monitor-profit-rank-badge \{[\s\S]*max-width: min\(150px, 100%\)/);
});

test('real-time feed supports immediate wallet-note editing without a full dashboard reload', () => {
  assert.match(appJs, /walletNote: String\(pickPresent\(\['walletNote', 'wallet_note', 'note'\]/);
  assert.match(appJs, /data-monitor-note-edit="\$\{escapeHtml\(event\.walletAddress\)\}"/);
  assert.match(appJs, /data-monitor-note-form="\$\{escapeHtml\(eventKey\)\}"/);
  assert.match(appJs, /maxlength="4000"/);
  assert.match(appJs, /elements\.monitorEventFeed\.addEventListener\('submit', \(event\) => void saveMonitorNote\(event\)\)/);
  const quickNoteSource = appJs.slice(
    appJs.indexOf('function updateMonitorWalletAnnotation'),
    appJs.indexOf('function renderMonitorPage')
  );
  assert.match(quickNoteSource, /const session = monitorSession\(editor\.chainId\)[\s\S]*fetchMonitorSessionJson\(context, `\/wallets\/\$\{encodeURIComponent\(editor\.address\)\}`, \{[\s\S]*method: 'PATCH'/);
  assert.match(quickNoteSource, /body: JSON\.stringify\(\{ note \}\)/);
  assert.match(quickNoteSource, /session\.events = session\.events\.map/);
  assert.match(quickNoteSource, /walletNoteKnown: true/);
  assert.doesNotMatch(quickNoteSource, /loadData\(/);
  assert.match(stylesCss, /\.monitor-note-editor \{[\s\S]*grid-template-columns: 11px minmax\(0, 1fr\) 24px 24px/);
  assert.match(stylesCss, /\.monitor-note-chip \{[\s\S]*text-overflow|\.monitor-note-chip span \{[\s\S]*text-overflow: ellipsis/);
  assert.match(appJs, /event\.isComposing \|\| event\.keyCode === 229/);
  assert.match(appJs, /addEventListener\('compositionstart'/);
  assert.match(appJs, /addEventListener\('compositionend'/);
  assert.match(appJs, /state\.monitorNoteEditor\?\.composing[\s\S]*state\.monitorNoteEditor\.value = activeInput\.value;[\s\S]*return;/);
  assert.match(appJs, /input\.focus\(\{ preventScroll: true \}\)/);
  assert.match(appJs, /input\.setSelectionRange\(activeEditor\.selectionStart, activeEditor\.selectionEnd\)/);
  assert.match(appJs, /const pickPresent = \(keys, fallback = null\)/);
  assert.match(quickNoteSource, /const sessionId = \+\+state\.monitorNoteSessionSequence/);
  assert.match(quickNoteSource, /state\.monitorNoteEditor\?\.sessionId === sessionId/);
});

test('wallet editor immediately refreshes monitor alias provenance', () => {
  const source = appJs.slice(
    appJs.indexOf('async function saveWalletEditor'),
    appJs.indexOf('async function disableConfirmedWallet')
  );
  assert.match(source, /const savedWallet = record\.wallet/);
  assert.match(source, /updateMonitorWalletAnnotation\(address, savedWallet\)/);
  assert.match(source, /updateMonitorWalletAnnotation\(address, savedWallet\)[\s\S]*renderMonitorEvents\(\)/);
});

test('real-time feed uses a compact scan-friendly hierarchy, event colors and one-shot arrival emphasis', () => {
  assert.match(stylesCss, /\.monitor-event-item \{[\s\S]*min-height: 84px/);
  assert.match(stylesCss, /\.monitor-event-title a \{[\s\S]*font-size: 13px/);
  assert.match(stylesCss, /\.monitor-event-amount \{[\s\S]*font-size: 12px/);
  assert.match(stylesCss, /\.monitor-event-item time \{[\s\S]*font-size: 10px/);
  assert.match(stylesCss, /\.monitor-event-meta span \{[\s\S]*font-size: 10px/);
  for (const eventType of ['buy', 'sell', 'transfer', 'token_create']) {
    assert.match(stylesCss, new RegExp(`\\.monitor-event-item\\[data-event-type="${eventType}"\\]`));
  }
  assert.match(stylesCss, /@keyframes monitor-event-arrival/);
  assert.match(stylesCss, /\.monitor-event-item\.is-new \{[\s\S]*animation: monitor-event-arrival 1\.8s ease-out 1/);
  assert.match(appJs, /state\.monitorFreshEventKeys\.delete\(eventKey\)/);
  assert.match(stylesCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
  assert.match(stylesCss, /@media \(max-width: 440px\)[\s\S]*\.monitor-event-metrics > div \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(stylesCss.slice(stylesCss.indexOf('.monitor-event-item {'), stylesCss.indexOf('.monitor-empty-state {')), /linear-gradient|radial-gradient/);
});

test('single-wallet browser sound is gesture-driven and strictly gated by soundAlert', () => {
  assert.match(indexHtml, /id="monitor-sound-button"[\s\S]*开启声音 \/ 试听/);
  assert.match(indexHtml, /id="monitor-sound-status"[^>]*data-enabled="false"/);
  assert.match(appJs, /elements\.monitorSoundButton\.addEventListener\('click'/);
  assert.match(appJs, /window\.AudioContext \|\| window\.webkitAudioContext/);
  assert.match(appJs, /声音提醒已开启/);
  assert.match(appJs, /声音提醒已关闭/);
  assert.match(appJs, /const soundAlert = pick\(\['soundAlert', 'sound_alert'\], false\) === true/);
  assert.match(appJs, /if \(!events\.some\(\(event\) => event\.soundAlert === true\)\) return/);
  assert.match(appJs, /if \(!initial && state\.monitorFeedChainIds\.has\(session\.chainId\)\) playMonitorEventSounds\(added\)/);
  assert.match(appJs, /playMonitorEventSounds\(added\);[\s\S]*synchronizeMonitorAlerts\(\{[\s\S]*sessions: \[session\]/);
  assert.match(appJs, /const walletUrl = safeHttpUrl\(event\.debotAddressUrl\) \|\| `\$\{eventChain\.debotAddressRoot\}\/\$\{event\.walletAddress\}`/);
  assert.match(appJs, /const transactionUrl = safeHttpUrl\(event\.explorerTxUrl\) \|\| explorerUrlForChain\(eventChain\.id, 'tx', event\.txHash\)/);
  assert.match(appJs, /金额不限/);
});

test('monitor alert settings provide persistent sound choices and bounded volume', () => {
  assert.match(indexHtml, /id="monitor-sound-select"[\s\S]*?<option value="alarm">警报<\/option>[\s\S]*?<option value="bell">铃声<\/option>[\s\S]*?<option value="electronic">电子<\/option>[\s\S]*?<option value="glass">玻璃<\/option>/);
  assert.match(indexHtml, /id="monitor-volume"[^>]*type="range"[^>]*min="0"[^>]*max="100"/);
  assert.match(appJs, /MONITOR_SOUNDS = new Set\(\['alarm', 'bell', 'electronic', 'glass'\]\)/);
  assert.match(appJs, /Math\.min\(100, Math\.max\(0, Math\.round\(number\)\)\)/);
  assert.match(appJs, /JSON\.stringify\(\{ sound, volume \}\)/);
  assert.match(appJs, /const sound = state\.monitorSound/);
  assert.match(appJs, /const volume = state\.monitorVolume/);
  assert.match(appJs, /patterns\[sound\]/);
  assert.match(appJs, /volume \/ 100/);
  assert.match(appJs, /if \(volume <= 0\) return/);
});

test('Bark alert sound and critical volume are independent from browser sound', () => {
  assert.match(indexHtml, /id="monitor-bark-sound-select"[\s\S]*?<option value="alarm">警报<\/option>[\s\S]*?<option value="chime">风铃<\/option>/);
  assert.match(indexHtml, /id="monitor-bark-volume"[^>]*type="range"[^>]*min="0"[^>]*max="10"/);
  assert.match(appJs, /JSON\.stringify\(\{ barkSound, barkVolume \}\)/);
  assert.match(appJs, /state\.monitorBarkSound = String\(settings\.barkSound/);
  assert.match(appJs, /Math\.min\(10, Math\.max\(0, Math\.round\(number\)\)\)/);
});

test('Bark targets can be added, tested, paused, resumed, and deleted without exposing full API keys', () => {
  for (const id of ['monitor-bark-form', 'monitor-bark-endpoint', 'monitor-bark-label', 'monitor-bark-list']) {
    assert.match(indexHtml, new RegExp(`id="${id}"`));
  }
  assert.match(indexHtml, /id="monitor-bark-endpoint"[^>]*type="password"/);
  assert.match(appJs, /endpointMasked: String\(source\.endpointMasked \|\| ''\)/);
  assert.doesNotMatch(appJs, /endpoint: String\(source\.endpoint/);
  assert.match(appJs, /fetchChainJson\(context, '\/monitor\/bark', \{[\s\S]*method: 'POST'[\s\S]*JSON\.stringify\(\{ endpoint, label, enabled: true \}\)/);
  assert.match(appJs, /fetchChainJson\(context, `\/monitor\/bark\/\$\{id\}\/test`, \{ method: 'POST' \}\)/);
  assert.match(appJs, /JSON\.stringify\(\{ enabled: !target\.enabled \}\)/);
  assert.match(appJs, /fetchChainJson\(context, `\/monitor\/bark\/\$\{id\}`, \{ method: 'DELETE' \}\)/);
  assert.match(appJs, /source\.addEventListener\('bark', \(\) => \{[\s\S]*isCurrentSource\(\) && session\.chainId === activeChainId[\s\S]*refreshBarkTargets\(\)/);
  for (const action of ['test', 'toggle', 'delete']) {
    assert.match(appJs, new RegExp(`data-bark-action="${action}"`));
  }
});

test('real-time monitoring remains contained on narrow mobile screens', () => {
  assert.match(stylesCss, /\.monitor-page \{[\s\S]*min-width: 0/);
  assert.match(stylesCss, /@media \(max-width: 760px\)[\s\S]*\.monitor-control-band \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(stylesCss, /\.monitor-event-item \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(stylesCss, /\.monitor-event-main \{[\s\S]*grid-column: 1 \/ -1/);
  assert.match(stylesCss, /\.monitor-event-title a \{[\s\S]*text-overflow: ellipsis/);
  assert.match(stylesCss, /@media \(max-width: 760px\)[\s\S]*\.monitor-alert-layout \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(stylesCss, /\.monitor-settings-form \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(stylesCss, /\.monitor-window-field input,[\s\S]*\.monitor-settings-form \.monitor-enabled-control,[\s\S]*\.monitor-settings-form \.monitor-save-button \{[\s\S]*width: 100%/);
  assert.match(stylesCss, /\.monitor-bark-item \{[\s\S]*min-width: 0/);
  assert.match(stylesCss, /@media \(max-width: 760px\)[\s\S]*\.manual-wallet-lines-field,[\s\S]*\.manual-wallet-feedback \{[\s\S]*grid-column: 1/);
  assert.match(stylesCss, /@media \(max-width: 760px\)[\s\S]*\.wallet-rule-row \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) repeat\(3, 46px\)/);
  assert.match(stylesCss, /\.monitor-event-meta \{[\s\S]*min-width: 0[\s\S]*flex-wrap: wrap/);
});
