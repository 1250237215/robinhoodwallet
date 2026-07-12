import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractProjectWebsiteCandidates,
  extractProjectXHandles,
  extractGithubUsernames,
  parseGithubRepoMarkdown,
  normalizeXProfileUrl,
  parseHtmlMetadata,
  parseGeckoTokenInfoPayload,
  fetchVirtualsSource,
  parseVirtualsPayload,
  parseVirtualsPrototypeMarkdown
} from '../src/sourceResolver.js';

test('extracts GitHub usernames from public profile text', () => {
  const usernames = extractGithubUsernames(`
    Founder profile: https://github.com/paoloanzn/free-code
    Docs mirror: github.com/Gladium-AI
    Ignore generic URL: https://github.com/topics/ai-agents
  `);

  assert.deepEqual(usernames, ['paoloanzn', 'Gladium-AI']);
});

test('normalizes X status links to profile URLs for dev lookup', () => {
  assert.equal(
    normalizeXProfileUrl('https://x.com/pvncher/status/2047388853338554742'),
    'https://x.com/pvncher'
  );
  assert.equal(normalizeXProfileUrl('@bondoncredit'), 'https://x.com/bondoncredit');
  assert.equal(normalizeXProfileUrl('https://x.com/search?q=demo'), null);
});

test('extracts project websites from X profile text without t.co or X links', () => {
  const urls = extractProjectWebsiteCandidates(`
    Mikael Sourati
    @MikaelSourati
    Building the future of recruiting | Founder @ Psview | 70K ARR in 3 months | 21 yo |
    [@fdotinc](https://x.com/fdotinc)
    San Francisco / Paris
    [psview.ai](https://t.co/ptm0W8HPeq)
  `);

  assert.deepEqual(urls, ['https://psview.ai']);
});

test('ignores X emoji and media asset URLs when guessing project websites', () => {
  const urls = extractProjectWebsiteCandidates(`
    deployer
    @0xDeployer
    currently deploying.
    ![Image 1](https://abs.twimg.com/emoji/v2/svg/1f923.svg)
    ![Image 2](https://pbs.twimg.com/profile_images/1816688728951476224/PkVN69ln_200x200.jpg)
    [Bankr](https://bankr.bot/launches/0xd9e3487e4ec470dbbb85323955ecc00d0733dba3)
  `);

  assert.deepEqual(urls, []);
});

test('ignores markdown filenames when guessing project websites from profile text', () => {
  const urls = extractProjectWebsiteCandidates(`
    just shipped: install any skill from github (SKILL.md + scripts, the whole thing)
    README.md and package.json are files, not project websites.
  `);

  assert.deepEqual(urls, []);
});

test('ignores version-like fake hostnames when guessing project websites', () => {
  const urls = extractProjectWebsiteCandidates(`
    Supports Python 3.x and Claude 3.x style workflows.
    This text should not turn https://3.x into a public project website.
  `);

  assert.deepEqual(urls, []);
});

test('ignores executable-like filenames when guessing project websites', () => {
  const urls = extractProjectWebsiteCandidates(`
    reverse engineering notes mention notepad.exe and calc.exe.
    Those are local executable names, not project websites.
  `);

  assert.deepEqual(urls, []);
});

test('extracts project X handles from a dev profile when the handle matches the token', () => {
  const handles = extractProjectXHandles(
    {
      symbol: 'DMN',
      name: 'Deamon Net'
    },
    `
      bolls
      @bolls
      I write exploits, patch them, then write better ones.
      working on // @dmn_net
      also chatting with @someoneelse
    `,
    '@bolls'
  );

  assert.deepEqual(handles, ['@dmn_net']);
});

test('does not treat ecosystem handles as project accounts just because they are token-name substrings', () => {
  const handles = extractProjectXHandles(
    {
      symbol: 'zBase',
      name: 'zBase'
    },
    `
      zBase
      @zbase__
      Privacy is for all, including your agents | @base Batches 003 Finalist
    `,
    '@zbase__'
  );

  assert.deepEqual(handles, []);
});

test('parses a GitHub repo page markdown as a fallback when the GitHub API is rate limited', () => {
  const parsed = parseGithubRepoMarkdown(
    `
Title: GitHub - mvanhorn/cli-printing-press: Every API has a secret identity. This finds it, absorbs every feature from every competing tool, then builds the GOAT CLI — designed for AI agents first, with SQLite sync, offline search, and compound insight commands.

URL Source: http://github.com/mvanhorn/cli-printing-press

Markdown Content:
Nothing is more valuable than time and money. In a world of AI agents, that's speed and token spend.
It fuses all of that and prints a token-efficient Go CLI plus a Claude Code skill plus an MCP server for any API or any website.
`
  );

  assert.equal(parsed.user.login, 'mvanhorn');
  assert.equal(parsed.repos[0].fullName, 'mvanhorn/cli-printing-press');
  assert.match(parsed.repos[0].description, /Every API has a secret identity|AI agents/i);
  assert.match(parsed.topRepoReadme, /token-efficient Go CLI|MCP server/i);
});

test('parses HTML title and meta description as website fallback content', () => {
  const parsed = parseHtmlMetadata(`
    <html>
      <head>
        <title>Psview</title>
        <meta name="description" content="Psview transforms recruiting with IA, automated sourcing, candidate selection, and precise decision data.">
        <meta property="og:url" content="https://psview.io">
      </head>
    </html>
  `);

  assert.deepEqual(parsed, {
    title: 'Psview',
    description:
      'Psview transforms recruiting with IA, automated sourcing, candidate selection, and precise decision data.',
    markdown:
      'Title: Psview\n\nMarkdown Content:\nPsview transforms recruiting with IA, automated sourcing, candidate selection, and precise decision data.'
  });
});

test('parses GeckoTerminal token info for Virtuals AI Agent evidence', () => {
  const parsed = parseGeckoTokenInfoPayload({
    data: {
      attributes: {
        address: '0xb2a99bc73c89b6bcbeb4650eedcd5f2776373c48',
        name: 'PSVIEW',
        symbol: 'PSVIEW',
        image_url: 'https://assets.geckoterminal.com/psview',
        websites: ['https://app.virtuals.io/virtuals/77450'],
        description: 'PSVIEW token',
        gt_score: 68.9907,
        gt_verified: false,
        categories: ['Virtuals Protocol', 'Ai Agents'],
        gt_category_ids: ['virtuals-protocol', 'ai-agents'],
        holders: {
          count: 453,
          distribution_percentage: {
            top_10: '49.226'
          }
        },
        is_honeypot: false
      }
    }
  });

  assert.deepEqual(parsed, {
    tokenAddress: '0xb2a99bc73c89b6bcbeb4650eedcd5f2776373c48',
    name: 'PSVIEW',
    symbol: 'PSVIEW',
    imageUrl: 'https://assets.geckoterminal.com/psview',
    websites: ['https://app.virtuals.io/virtuals/77450'],
    description: 'PSVIEW token',
    categories: ['Virtuals Protocol', 'Ai Agents'],
    categoryIds: ['virtuals-protocol', 'ai-agents'],
    holderCount: 453,
    top10HolderPercentage: 49.226,
    isHoneypot: false,
    gtScore: 68.9907,
    gtVerified: false,
    virtualsUrl: 'https://app.virtuals.io/virtuals/77450',
    virtualsId: 77450
  });
});

test('parses Virtuals launch payload with creator Twitter and fee delegation', () => {
  const parsed = parseVirtualsPayload(
    {
      data: [
        {
          id: 77450,
          name: 'PSVIEW',
          description: 'PSVIEW token',
          category: 'IP MIRROR',
          tokenAddress: '0xb2A99BC73c89B6bcbeB4650eedcD5f2776373C48',
          symbol: 'PSVIEW',
          lpAddress: '0xb7Cd695a77994aFe94EcBAee85B0EAb5e0Aa43fD',
          holderCount: 453,
          top10HolderPercentage: 49.23,
          priceChangePercent24h: 17.66,
          volume24h: 725056.62,
          liquidityUsd: 123887.67,
          isVerified: false,
          isDevCommitted: false,
          factory: 'BONDING_V5',
          launchedAt: '2026-05-23T09:34:41.000Z',
          taxRecipient: '0x65e2F5E14Cc8d294fc2ADD3e9108377a1259cB59',
          creator: {
            socials: {
              VERIFIED_LINKS: {
                TWITTER: 'https://x.com/MikaelSourati'
              },
              VERIFIED_USERNAMES: {
                TWITTER: 'MikaelSourati'
              }
            }
          },
          launchInfo: {
            feeDelegationType: 'twitter',
            feeDelegatedRecipient: 'MikaelSourati',
            feeDelegationVaultAddress: '0xC6F6F0Ba2C40d313C58b16BaB7131408BD7EED75',
            feeDelegationClaimed: true
          }
        }
      ]
    },
    '0xb2a99bc73c89b6bcbeb4650eedcd5f2776373c48'
  );

  assert.equal(parsed.id, 77450);
  assert.equal(parsed.url, 'https://app.virtuals.io/virtuals/77450');
  assert.equal(parsed.tokenAddress, '0xb2a99bc73c89b6bcbeb4650eedcd5f2776373c48');
  assert.equal(parsed.category, 'IP MIRROR');
  assert.equal(parsed.creatorTwitterUrl, 'https://x.com/MikaelSourati');
  assert.equal(parsed.creatorTwitterHandle, '@MikaelSourati');
  assert.equal(parsed.feeDelegationType, 'twitter');
  assert.equal(parsed.feeDelegatedRecipient, 'MikaelSourati');
  assert.equal(parsed.feeDelegationClaimed, true);
  assert.equal(parsed.taxRecipient, '0x65e2F5E14Cc8d294fc2ADD3e9108377a1259cB59');
});

test('parses Virtuals project socials, video pitch and team members', () => {
  const parsed = parseVirtualsPayload(
    {
      data: {
        id: 76475,
        name: 'OrionX Robotics',
        symbol: 'ORION',
        description: 'Physical AI robotics agent',
        overview: 'ARES is the VLA brain for humanoid robots in hazardous environments.',
        category: 'IP MIRROR',
        walletAddress: '0x9BA60E0ACB75a730b9830Fa74836e800E47a1580',
        tokenAddress: '0x96De193C2F6FE14d931eAADA5Abd6fb372a8D2A5',
        taxRecipient: null,
        socials: {
          VIDEO_PITCH: {
            TWEET_URL: 'https://x.com/OrionX_Robotics/status/2055173430476234977',
            VIDEO_URL: 'https://video.twimg.com/amplify_video/2055172594769461249/vid/avc1/1920x1080/_0u86N84kk6FlztY.mp4'
          },
          VERIFIED_LINKS: {
            TWITTER: 'https://x.com/OrionX_Robotics',
            WEBSITE: 'https://orionxrobotics.xyz/'
          },
          VERIFIED_USERNAMES: {
            TWITTER: 'OrionX_Robotics'
          }
        },
        tokenUtility:
          'Revenue Share, Buyback & Burn, Stake-to-Use, Hardware Bridge, Intel Feed and Governance for OrionX Robotics.',
        roadmap: 'Phase 1 — Foundation & Public Launch · Q2 2026. ARES v0.2, Unitree G1 EDU and Isaac Sim.',
        additionalDetails:
          'The Battlefield AI Gap. OrionX builds the brain for humanoid robots and wants to be the Anduril of the humanoid age.',
        launchInfo: {
          feeDelegationType: null,
          feeDelegatedRecipient: null,
          feeDelegationVaultAddress: null,
          feeDelegationClaimed: false
        },
        projectMembers: [
          {
            title: 'Co-Founder & CEO',
            user: {
              socials: {
                VERIFIED_LINKS: { TWITTER: 'https://x.com/VictorRowanAi' },
                VERIFIED_USERNAMES: { TWITTER: 'VictorRowanAi' }
              },
              bio:
                'Victor Rowan\nCo-Founder & CEO · Defense Partnerships & GTM\n\nB.Tech Electronics. Ex-Neurolov AI infrastructure at $13M+ government contract scale via Adani Defence.'
            }
          },
          {
            title: 'Adhik Joshi (Co-Founder & CTO))',
            user: {
              socials: {
                VERIFIED_LINKS: { TELEGRAM: 'https://t.me/rebond97' },
                VERIFIED_USERNAMES: { TELEGRAM: 'rebond97' }
              },
              bio:
                'Co-Founder & CTO · ARES VLA System & Robotics\n\nB.Tech Computer Science. AI Systems Architect across NVIDIA GR00T, OpenVLA, Physical Intelligence pi-zero and Isaac Sim.\n\nGitHub: github.com/adhikjoshi'
            }
          }
        ]
      }
    },
    '0x96de193c2f6fe14d931eaada5abd6fb372a8d2a5'
  );

  assert.equal(parsed.id, 76475);
  assert.equal(parsed.url, 'https://app.virtuals.io/virtuals/76475');
  assert.equal(parsed.projectTwitterUrl, 'https://x.com/OrionX_Robotics');
  assert.equal(parsed.projectTwitterHandle, '@OrionX_Robotics');
  assert.equal(parsed.projectWebsiteUrl, 'https://orionxrobotics.xyz/');
  assert.equal(parsed.videoPitchTweetUrl, 'https://x.com/OrionX_Robotics/status/2055173430476234977');
  assert.equal(parsed.virtualsWalletAddress, '0x9ba60e0acb75a730b9830fa74836e800e47a1580');
  assert.equal(parsed.taxRecipient, null);
  assert.match(parsed.tokenUtility, /Revenue Share/);
  assert.match(parsed.roadmap, /ARES v0\.2/);
  assert.match(parsed.additionalDetails, /Anduril/);
  assert.equal(parsed.projectMembers.length, 2);
  assert.equal(parsed.projectMembers[0].twitterHandle, '@VictorRowanAi');
  assert.equal(parsed.projectMembers[1].githubUsername, 'adhikjoshi');
  assert.equal(parsed.projectMembers[1].githubUrl, 'https://github.com/adhikjoshi');
});

test('parses a Virtuals prototype page delegate as the dev signal', () => {
  const parsed = parseVirtualsPrototypeMarkdown(
    `
Title: Virtuals Protocol | Society of AI Agents

URL Source: http://app.virtuals.io/prototypes/0x8cb8bd0fee144ca6dd4f2a98374b0a0c90810401

Markdown Content:
# LITEFOLD $0.000210 | Virtuals Protocol | Society of AI Agents

LITEFOLD

$LITEFOLD

0x8Cb8...810401

Delegate to:

[@anindyadeeps ![Image 12: Pill](blob:http://localhost/3b545241d3914ae3d6ddb5e9f8b79570)](https://twitter.com/anindyadeeps)

Market Cap

$211.7K
`,
    '0x8cb8bd0fee144ca6dd4f2a98374b0a0c90810401'
  );

  assert.equal(parsed.url, 'https://app.virtuals.io/prototypes/0x8cb8bd0fee144ca6dd4f2a98374b0a0c90810401');
  assert.equal(parsed.prototypeAddress, '0x8cb8bd0fee144ca6dd4f2a98374b0a0c90810401');
  assert.equal(parsed.tokenAddress, '0x8cb8bd0fee144ca6dd4f2a98374b0a0c90810401');
  assert.equal(parsed.name, 'LITEFOLD');
  assert.equal(parsed.symbol, 'LITEFOLD');
  assert.equal(parsed.category, 'PROTOTYPE');
  assert.equal(parsed.creatorTwitterUrl, 'https://x.com/anindyadeeps');
  assert.equal(parsed.creatorTwitterHandle, '@anindyadeeps');
  assert.equal(parsed.feeDelegationType, 'twitter');
  assert.equal(parsed.feeDelegatedRecipient, 'anindyadeeps');
  assert.equal(parsed.feeDelegationClaimed, null);
});

test('fetches Virtuals detail by id when token lookup omits project members', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/api/virtuals?')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 76475,
              name: 'OrionX Robotics',
              symbol: 'ORION',
              tokenAddress: '0x96De193C2F6FE14d931eAADA5Abd6fb372a8D2A5',
              socials: {
                VERIFIED_LINKS: {
                  TWITTER: 'https://x.com/OrionX_Robotics',
                  WEBSITE: 'https://orionxrobotics.xyz/'
                },
                VERIFIED_USERNAMES: {
                  TWITTER: 'OrionX_Robotics'
                }
              },
              projectMembers: []
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (String(url).includes('/api/virtuals/76475?')) {
      return new Response(
        JSON.stringify({
          data: {
            id: 76475,
            name: 'OrionX Robotics',
            symbol: 'ORION',
            tokenAddress: '0x96De193C2F6FE14d931eAADA5Abd6fb372a8D2A5',
            walletAddress: '0x9BA60E0ACB75a730b9830Fa74836e800E47a1580',
            socials: {
              VIDEO_PITCH: {
                TWEET_URL: 'https://x.com/OrionX_Robotics/status/2055173430476234977'
              },
              VERIFIED_LINKS: {
                TWITTER: 'https://x.com/OrionX_Robotics',
                WEBSITE: 'https://orionxrobotics.xyz/'
              },
              VERIFIED_USERNAMES: {
                TWITTER: 'OrionX_Robotics'
              }
            },
            projectMembers: [
              {
                title: 'Co-Founder & CEO',
                user: {
                  socials: {
                    VERIFIED_LINKS: { TWITTER: 'https://x.com/VictorRowanAi' },
                    VERIFIED_USERNAMES: { TWITTER: 'VictorRowanAi' }
                  },
                  bio: 'Victor Rowan\nCo-Founder & CEO · Defense Partnerships & GTM'
                }
              }
            ]
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const parsed = await fetchVirtualsSource('0x96de193c2f6fe14d931eaada5abd6fb372a8d2a5');

    assert.equal(calls.some((url) => url.includes('/api/virtuals?')), true);
    assert.equal(calls.some((url) => url.includes('/api/virtuals/76475?')), true);
    assert.equal(parsed.projectTwitterHandle, '@OrionX_Robotics');
    assert.equal(parsed.projectMembers.length, 1);
    assert.equal(parsed.projectMembers[0].twitterHandle, '@VictorRowanAi');
    assert.equal(parsed.virtualsWalletAddress, '0x9ba60e0acb75a730b9830fa74836e800e47a1580');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
