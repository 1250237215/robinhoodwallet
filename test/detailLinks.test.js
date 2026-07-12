import test from 'node:test';
import assert from 'node:assert/strict';

import {
  basescanAddressUrl,
  buildDetailLinks,
  renderLinkedValue
} from '../public/detailLinks.js';

test('builds clickable detail links for dev identity sources', () => {
  const links = buildDetailLinks({
    devHandle: '@pvncher',
    feeRecipientHandle: '@pvncher',
    feeRecipientWallet: '0x19920784fb1910b1903cc80165b2350a3f55a447',
    bankr: {
      url: 'https://bankr.bot/launches/0x9b92d189a80d70a4bb5d8ac02e25b59b7f0c8ba3',
      deployerHandle: '@hyporliquid'
    }
  });

  assert.equal(links.devUrl, 'https://x.com/pvncher');
  assert.equal(links.feeRecipientUrl, 'https://x.com/pvncher');
  assert.equal(
    links.feeRecipientWalletUrl,
    'https://basescan.org/address/0x19920784fb1910b1903cc80165b2350a3f55a447'
  );
  assert.equal(links.bankrUrl, 'https://bankr.bot/launches/0x9b92d189a80d70a4bb5d8ac02e25b59b7f0c8ba3');
  assert.equal(links.deployerUrl, 'https://x.com/hyporliquid');
});

test('renders linked values safely', () => {
  assert.equal(
    renderLinkedValue('@pvncher', 'https://x.com/pvncher'),
    '<a href="https://x.com/pvncher" target="_blank" rel="noreferrer">@pvncher</a>'
  );
  assert.equal(
    renderLinkedValue('0x19920784fb1910b1903cc80165b2350a3f55a447', basescanAddressUrl('0x19920784fb1910b1903cc80165b2350a3f55a447')),
    '<a href="https://basescan.org/address/0x19920784fb1910b1903cc80165b2350a3f55a447" target="_blank" rel="noreferrer">0x19920784fb1910b1903cc80165b2350a3f55a447</a>'
  );
});
