import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const indexHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const stylesCss = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

test('home is the manual Robinhood smart-money workspace', () => {
  assert.match(indexHtml, /<title>Robinhood 聪明钱雷达<\/title>/);
  assert.match(indexHtml, /<h1 id="brand-title">Robinhood 聪明钱雷达<\/h1>/);
  assert.match(indexHtml, /手工金狗、最近重扫候选与已确认地址库/);
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
  assert.match(indexHtml, /data-tab="candidates"[^>]*aria-selected="true"/);
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
  assert.match(appJs, /activeTab: 'candidates',\s+strategy: 'smart',\s+multiple: 10/);
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

test('pending review wallets load independently and only the latest completed scan batch is shown', () => {
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
  assert.match(apiLoaderSource, /pendingWalletsPromise = loadPendingWallets\(context, filters\)/);
  assert.equal((apiLoaderSource.match(/latestReviewBatch\(pendingWallets, jobs, winners, filters\.minEntryUsd\)/g) || []).length, 2);
  assert.equal((apiLoaderSource.match(/walletLibraryRecords\(curationWallets\),\s*reviewBatch\.wallets/g) || []).length, 2);
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
  assert.match(indexHtml, /aria-label="刷新数据"/);
  assert.match(indexHtml, /title="重扫手工金狗" aria-label="重扫手工金狗"/);
  assert.match(appJs, /window\.lucide\?\.createIcons/);
});

test('relative static assets and a scoped API root support VPS prefix deployment', () => {
  assert.match(indexHtml, /href="styles\.css"/);
  assert.match(indexHtml, /src="app\.js"/);
  assert.match(appJs, /window\.location\.pathname\.startsWith\('\/robinhood-radar\/'\)/);
  assert.match(appJs, /API_ROOT = `\$\{APP_BASE\}\/api\/\$\{chain\.apiPath\}`/);
});

test('a three-chain segmented switcher selects Robinhood, Base, and Solana independently', () => {
  const switcher = indexHtml.match(
    /<div class="chain-switcher" id="chain-switcher"[\s\S]*?<\/div>/
  )?.[0] || '';
  assert.equal((switcher.match(/data-chain=/g) || []).length, 3);
  for (const [chain, label, pressed] of [
    ['robinhood', 'Robinhood', 'true'],
    ['base', 'Base', 'false'],
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
  assert.match(stylesCss, /\.chain-switcher \{[\s\S]*grid-template-columns: repeat\(3/);
  assert.match(stylesCss, /@media \(max-width: 760px\)[\s\S]*\.chain-switcher \{[\s\S]*repeat\(3, minmax\(0, 1fr\)\)/);
});

test('active-chain configuration drives API roots and browser settings keys', () => {
  const syncSource = appJs.slice(
    appJs.indexOf('function syncChainRuntimeVariables'),
    appJs.indexOf('function explorerUrl')
  );
  assert.match(syncSource, /API_ROOT = `\$\{APP_BASE\}\/api\/\$\{chain\.apiPath\}`/);
  assert.match(syncSource, /EXPLORER_ROOT = chain\.explorerRoot/);
  assert.match(syncSource, /DEBOT_ADDRESS_ROOT = chain\.debotAddressRoot/);
  assert.match(syncSource, /DEBOT_TOKEN_ROOT = chain\.debotTokenRoot/);
  assert.match(syncSource, /DEBOT_WALLET_MANAGER_URL = chain\.debotWalletManagerUrl/);
  assert.match(syncSource, /MONITOR_THRESHOLD_STORAGE_KEY = `\$\{chain\.id\}-monitor-threshold`/);

  for (const [chain, apiPath] of [['robinhood', 'robinhood'], ['base', 'base'], ['solana', 'solana']]) {
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

test('Solana addresses and signatures retain case while EVM identities normalize to lowercase', () => {
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

  const solanaConfig = appJs.slice(
    appJs.indexOf('solana: Object.freeze({'),
    appJs.indexOf('\n  })', appJs.indexOf('solana: Object.freeze({'))
  );
  assert.match(solanaConfig, /family: 'solana'/);
  assert.match(solanaConfig, /nativeSymbol: 'SOL'/);
  assert.match(solanaConfig, /addressPattern: \/\^\[1-9A-HJ-NP-Za-km-z\]\{32,44\}\$\//);
  assert.match(solanaConfig, /hashPattern: \/\^\[1-9A-HJ-NP-Za-km-z\]\{64,88\}\$\//);
  assert.match(appJs, /activeChain\(\)\.family === 'solana'[\s\S]*Solana Base58 Mint 地址/);
  assert.match(appJs, /event\.assetType === 'native' \? activeChain\(\)\.nativeSymbol : 'TOKEN'/);
});

test('switching chains closes live transport, clears chain data, and invalidates stale requests', () => {
  const stopSource = appJs.slice(
    appJs.indexOf('function stopMonitorTransport'),
    appJs.indexOf('function scheduleMonitorPoll')
  );
  assert.match(stopSource, /state\.monitorSequence \+= 1/);
  assert.match(stopSource, /state\.monitorEventSource\.close\(\)/);
  assert.match(stopSource, /state\.monitorEventSource = null/);

  const resetSource = appJs.slice(
    appJs.indexOf('function resetChainState'),
    appJs.indexOf('function switchChain')
  );
  for (const operation of [
    'stopMonitorTransport();',
    'state.requestSequence += 1;',
    'state.detailSequence += 1;',
    'state.data = null;',
    'state.visibleWallets = [];',
    'state.selectedCandidates.clear();',
    'state.rescanningWinnerAddresses.clear();',
    'state.detailCache.clear();',
    'state.monitorEvents = [];',
    'state.monitorServerClusters = [];',
    'state.monitorEventKeys.clear();',
    'state.monitorAlertedTokens.clear();',
    'state.monitorBarkTargets = [];'
  ]) {
    assert.equal(resetSource.includes(operation), true, `missing chain reset: ${operation}`);
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
  assert.match(switchSource, /resetChainState\(\)/);
  assert.ok(
    switchSource.indexOf('state.chainAbortController.abort();') < switchSource.indexOf('activeChainId = nextChainId'),
    'old-chain fetches must abort before the active chain changes'
  );
  assert.ok(
    switchSource.indexOf('state.chainAbortController = new AbortController();') < switchSource.indexOf('resetChainState();'),
    'new-chain operations must receive a fresh signal before loading starts'
  );

  const pollSource = appJs.slice(
    appJs.indexOf('async function pollMonitorEvents'),
    appJs.indexOf('function connectMonitorStream')
  );
  assert.match(pollSource, /const context = captureChainRequestContext\(\)/);
  assert.match(pollSource, /const sequence = state\.monitorSequence/);
  assert.match(pollSource, /!chainRequestIsCurrent\(context\) \|\| sequence !== state\.monitorSequence/);

  const streamSource = appJs.slice(
    appJs.indexOf('function connectMonitorStream'),
    appJs.indexOf('async function startMonitorPage')
  );
  assert.match(streamSource, /new EventSource\(`\$\{context\.apiRoot\}\/monitor\/stream`\)/);
  assert.match(streamSource, /const isCurrentSource = \(\) => state\.monitorEventSource === source && chainRequestIsCurrent\(context\)/);
  assert.match(streamSource, /if \(!isCurrentSource\(\)\) return/);

  const loadSource = appJs.slice(
    appJs.indexOf('async function loadData'),
    appJs.indexOf('async function startScan')
  );
  assert.match(loadSource, /const context = captureChainRequestContext\(\)/);
  assert.match(loadSource, /const sequence = \+\+state\.requestSequence/);
  assert.match(loadSource, /if \(!chainRequestIsCurrent\(context\) \|\| sequence !== state\.requestSequence\) return/);
  assert.match(loadSource, /if \(data\.chain && data\.chain !== context\.chainId\) return/);
  assert.match(appJs, /if \(record\.chain && String\(record\.chain\) !== activeChainId\) return/);
  assert.match(appJs, /if \(rawEvent\.chain && String\(rawEvent\.chain\) !== activeChainId\) return/);
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

  assert.equal((appJs.match(/\bfetchJson\(/g) || []).length, 2, 'API calls must go through fetchChainJson');
  assert.doesNotMatch(appJs, /\$\{API_ROOT\}\//, 'async paths must not interpolate the mutable API root');

  const guardedOperations = [
    ['saveMonitorSoundSettings', 'saveBarkSoundSettings'],
    ['createBarkTarget', 'runBarkAction'],
    ['runBarkAction', 'refreshBarkTargets'],
    ['startMonitorPage', 'saveMonitorSettings'],
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

  const resetSource = appJs.slice(
    appJs.indexOf('function resetChainState'),
    appJs.indexOf('function switchChain')
  );
  for (const control of [
    'elements.refreshButton.disabled = false;',
    'elements.manualWalletAddButton.disabled = false;',
    'elements.monitorRefreshButton.disabled = false;',
    'elements.monitorBarkAddButton.disabled = false;'
  ]) {
    assert.equal(resetSource.includes(control), true, `chain reset must release control: ${control}`);
  }
});

test('DeBot and explorer links are generated from the active chain only', () => {
  for (const [chain, debotAddress, explorer] of [
    ['robinhood', 'https://debot.ai/address/robinhood', 'https://robinhoodchain.blockscout.com'],
    ['base', 'https://debot.ai/address/base', 'https://base.blockscout.com'],
    ['solana', 'https://debot.ai/address/solana', 'https://solscan.io']
  ]) {
    const configStart = appJs.indexOf(`${chain}: Object.freeze({`);
    const configEnd = appJs.indexOf('\n  })', configStart);
    const config = appJs.slice(configStart, configEnd);
    assert.ok(configStart >= 0 && configEnd > configStart);
    assert.equal(config.includes(`debotAddressRoot: '${debotAddress}'`), true);
    assert.equal(config.includes(`explorerRoot: '${explorer}'`), true);
  }

  const explorerSource = appJs.slice(
    appJs.indexOf('function explorerUrl'),
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
  assert.match(monitorRender, /`\$\{DEBOT_ADDRESS_ROOT\}\/\$\{event\.walletAddress\}`/);
  assert.match(monitorRender, /`\$\{DEBOT_TOKEN_ROOT\}\$\{event\.tokenAddress\}`/);
  assert.match(monitorRender, /explorerUrl\('tx', event\.txHash\)/);
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

test('real-time monitoring is a first-level page that replaces the research workspace cleanly', () => {
  assert.match(indexHtml, /data-tab="monitor"[^>]*aria-selected="false"[\s\S]*?实时监控/);
  assert.match(indexHtml, /id="monitor-page"[^>]*hidden/);
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
    'monitor-cluster-list',
    'monitor-event-feed'
  ]) {
    assert.match(indexHtml, new RegExp(`id="${id}"`));
  }
  assert.match(appJs, /elements\.submissionDock\.hidden = showingMonitor/);
  assert.match(appJs, /elements\.researchBoard\.hidden = showingMonitor/);
  assert.match(appJs, /elements\.monitorPage\.hidden = !showingMonitor/);
  assert.match(appJs, /if \(state\.activeTab === 'monitor'\)[\s\S]*startMonitorPage/);
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
  assert.match(healthSource, /当前仅 Holder 分析可用/);

  const renderSource = appJs.slice(
    appJs.indexOf('function monitorConnectionState'),
    appJs.indexOf('function renderMonitorClusters')
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
  assert.match(appJs, /refreshRecent \? '0' : state\.monitorLastEventId/);
  assert.match(appJs, /\/monitor\/events\?after=\$\{after\}&limit=200/);
  assert.match(appJs, /\/monitor\?since=\$\{after\}&limit=200/);
  assert.match(appJs, /state\.monitorTransport === 'sse'/);
  assert.match(appJs, /state\.monitorEvents\.sort\(\(left, right\) => monitorEventTimestamp\(right\) - monitorEventTimestamp\(left\)\)/);
});

test('custom-window clusters count distinct wallets and permanently deduplicate alerted CAs', () => {
  assert.match(indexHtml, /id="monitor-cluster-title">60 秒同币聚合/);
  assert.match(indexHtml, /滚动统计最近 60 秒的不同地址/);
  assert.match(indexHtml, /id="monitor-window-chip-label">60 秒/);
  assert.match(appJs, /function formatMonitorWindowDuration\(value = state\.monitorWindowSeconds\)/);
  assert.match(appJs, /elements\.monitorWindowDescription\.textContent = `已确认地址 · 金额不限 · \$\{windowLabel\}滚动窗口`/);
  assert.match(appJs, /elements\.monitorThresholdLabel\.textContent = `\$\{windowLabel\}同币提醒人数`/);
  assert.match(appJs, /elements\.monitorClusterTitle\.textContent = `\$\{windowLabel\}同币聚合`/);
  assert.match(appJs, /elements\.monitorWindowChipLabel\.textContent = windowLabel/);
  assert.match(appJs, /elements\.monitorClusterSummary\.textContent = `滚动 \$\{windowLabel\}/);
  assert.match(appJs, /state\.monitorWindowSeconds\) \* 1000/);
  assert.match(appJs, /if \(!cluster\.wallets\.has\(event\.walletAddress\)\) cluster\.wallets\.set/);
  assert.match(appJs, /walletCount: cluster\.wallets\.size/);
  assert.match(appJs, /if \(cluster\.walletCount < state\.monitorThreshold\) continue/);
  assert.match(appJs, /if \(!state\.monitorAlertedTokens\.has\(cluster\.key\)\)/);
  assert.match(appJs, /Array\.isArray\(record\.alertedTokenAddresses\)/);
  assert.match(appJs, /state\.monitorAlertedTokens\.add\(normalized\)/);
  assert.match(appJs, /synchronizeMonitorAlerts\(\{ playNew: !initial && added\.length > 0 \}\);[\s\S]{0,260}state\.monitorAlertedTokens\.add\(normalized\)/);
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
  assert.match(appJs, /平台 \$\{escapeHtml\(monitorPlatformLabel\(event\.platform\)\)\}/);
  assert.match(appJs, /event\.eventType === 'token_create'[^\n]+Noxa 发币[^\n]+直接部署/);
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
  assert.match(mergeSource, /normalizeMonitorEvent\(rawEvent, state\.monitorEvents\[existingIndex\]\)/);
  assert.doesNotMatch(mergeSource, /state\.monitorEventKeys\.has\(key\)[^\n]+continue/);
  assert.match(appJs, /source\.addEventListener\('event_update', \(event\) => \{[\s\S]*if \(isCurrentSource\(\)\) applyMonitorStreamEventUpdate\(event\)/);
  assert.match(appJs, /eventIds\.map\(\(id\) => \(\{ \.\.\.source, id \}\)\)/);
  assert.match(appJs, /formatMonitorMarketCap\(event\.marketCapUsd\)/);
  assert.match(appJs, /monitorTimestampMs\(event\?\.blockTimestamp\)[\s\S]*monitorTimestampMs\(event\?\.tokenCreationTimestamp\)/);
  assert.match(appJs, /<dt>发现时市值<\/dt>/);
  assert.match(appJs, /event\.eventType === 'buy' \? '买入时币龄' : '事件时币龄'/);
  assert.match(appJs, /marketCap === null \? '待获取'/);
  assert.match(appJs, /tokenAge !== '待获取'/);
});

test('real-time feed uses scan-friendly hierarchy, event colors and one-shot arrival emphasis', () => {
  assert.match(stylesCss, /\.monitor-event-title a \{[\s\S]*font-size: 16px/);
  assert.match(stylesCss, /\.monitor-event-amount \{[\s\S]*font-size: 15px/);
  assert.match(stylesCss, /\.monitor-event-item time \{[\s\S]*font-size: 12px/);
  assert.match(stylesCss, /\.monitor-event-meta span \{[\s\S]*font-size: 12px/);
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
  assert.match(appJs, /if \(!initial\) playMonitorEventSounds\(added\)/);
  assert.match(appJs, /playMonitorEventSounds\(added\);[\s\S]*synchronizeMonitorAlerts/);
  assert.match(appJs, /const walletUrl = safeHttpUrl\(event\.debotAddressUrl\) \|\| `\$\{DEBOT_ADDRESS_ROOT\}\/\$\{event\.walletAddress\}`/);
  assert.match(appJs, /const transactionUrl = safeHttpUrl\(event\.explorerTxUrl\) \|\| explorerUrl\('tx', event\.txHash\)/);
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
  assert.match(appJs, /source\.addEventListener\('bark', \(\) => \{[\s\S]*if \(isCurrentSource\(\)\) void refreshBarkTargets\(context\)/);
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
