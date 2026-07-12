import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCoinProfile,
  parseBankrLaunchApi,
  parseBankrLaunchMarkdown,
  parseXInitialStateHtml,
  parseXProfileMarkdown
} from '../src/profileBuilder.js';

test('parses fee recipient from a Bankr launch page', () => {
  const parsed = parseBankrLaunchMarkdown(`
# Bankr

## MonidAI

DEPLOYED

$Monid

## Token Info

Launcher

Fee Recipient

?0xc403310ccf4ce8668610f79adf9832c2beea62bf

[](https://basescan.org/address/0xc403310ccf4ce8668610f79adf9832c2beea62bf "View on BaseScan")

Chain

base
`);

  assert.deepEqual(parsed, {
    tokenName: 'MonidAI',
    feeRecipientWallet: '0xc403310ccf4ce8668610f79adf9832c2beea62bf',
    feeRecipientHandle: null,
    feeRecipientUrl: null,
    chain: 'base',
    launcher: null
  });
});

test('parses an X account fee recipient from a Bankr launch page', () => {
  const parsed = parseBankrLaunchMarkdown(`
# Bankr

## bond.credit

DEPLOYED

$BOND

## Token Info

Launcher

Fee Recipient

[@bondoncredit](https://x.com/bondoncredit)

Chain

base

Contract Address

0xca2c020d4572f7de62c051e2aa95b8cfeae4dba3[](https://basescan.org/address/0xca2c020d4572f7de62c051e2aa95b8cfeae4dba3 "View on BaseScan")
`);

  assert.equal(parsed.tokenName, 'bond.credit');
  assert.equal(parsed.feeRecipientWallet, null);
  assert.equal(parsed.feeRecipientHandle, '@bondoncredit');
  assert.equal(parsed.feeRecipientUrl, 'https://x.com/bondoncredit');
  assert.equal(parsed.chain, 'base');
});

test('does not use the contract address when the Bankr fee recipient field is empty', () => {
  const parsed = parseBankrLaunchMarkdown(`
# Bankr

## bond.credit

DEPLOYED

$BOND

## Token Info

Launcher

Fee Recipient

Chain

base

Contract Address

0xca2c020d4572f7de62c051e2aa95b8cfeae4dba3[](https://basescan.org/address/0xca2c020d4572f7de62c051e2aa95b8cfeae4dba3 "View on BaseScan")
`);

  assert.equal(parsed.feeRecipientWallet, null);
  assert.equal(parsed.feeRecipientHandle, null);
});

test('parses Bankr launch API fee recipient and deployer identities', () => {
  const parsed = parseBankrLaunchApi({
    launch: {
      tokenName: 'bond.credit',
      tokenSymbol: 'BOND',
      chain: 'base',
      tokenAddress: '0xca2c020d4572f7de62c051e2aa95b8cfeae4dba3',
      txHash: '0x820d9394d09020727460da6deabaf83b313a635a8744892475a543a2de2caf1c',
      deployer: {
        walletAddress: '0xb1c6cc3e066175c5b3237cb6af73616162e890da',
        xUsername: 'papaldo2614'
      },
      feeRecipient: {
        walletAddress: '0x20c1e69a5af8044e8ad8f7e26e2ac478ea4d8d8d',
        xUsername: 'bondoncredit'
      },
      tweetUrl: 'https://x.com/bondoncredit/status/1975624703361331224?s=20',
      timestamp: 1779199811328
    }
  });

  assert.equal(parsed.tokenName, 'bond.credit');
  assert.equal(parsed.feeRecipientWallet, '0x20c1e69a5af8044e8ad8f7e26e2ac478ea4d8d8d');
  assert.equal(parsed.feeRecipientHandle, '@bondoncredit');
  assert.equal(parsed.feeRecipientUrl, 'https://x.com/bondoncredit');
  assert.equal(parsed.deployerWallet, '0xb1c6cc3e066175c5b3237cb6af73616162e890da');
  assert.equal(parsed.deployerHandle, '@papaldo2614');
});

test('parses key public facts from an X profile markdown snapshot', () => {
  const parsed = parseXProfileMarkdown(`
# Monid (@monid_ai) / X

## Monid

29 posts

Monid

@monid_ai

One skill, every tool your agent needs.

[monid.ai](https://t.co/kgiRfHuE3Q)

[Joined March 2026](https://x.com/monid_ai/about)

[3 Following](https://x.com/monid_ai/following)

[425 Followers](https://x.com/monid_ai/verified_followers)
`);

  assert.deepEqual(parsed, {
    displayName: 'Monid',
    handle: '@monid_ai',
    bio: 'One skill, every tool your agent needs.',
    joined: 'March 2026',
    followers: 425,
    following: 3,
    posts: 29
  });
});

test('parses X profile and pinned tweet facts from logged-out HTML state', () => {
  const parsed = parseXInitialStateHtml(`
<script>window.__INITIAL_STATE__={"entities":{"users":{"entities":{"1945788728536125440":{"name":"bond.credit","screen_name":"bondoncredit","description":"The credit layer for the agentic economy.","followers_count":1189,"friends_count":16,"statuses_count":715,"created_at":"2025-07-17T10:12:49.000Z"}}},"tweets":{"entities":{"1975624703361331224":{"full_text":"Credit is an invaluable tool for growth. This is doubly important in the Agentic Economy, where strategies scale with capital. Our architecture extends underwritten credit lines and risk-adjusted leverage through verifiable credit.","created_at":"2025-10-07T18:10:09.000Z","user":"1945788728536125440"}}}}};window.__META_DATA__={"env":"prod"};</script>
`);

  assert.deepEqual(parsed, {
    displayName: 'bond.credit',
    handle: '@bondoncredit',
    bio: 'The credit layer for the agentic economy.',
    joined: '2025-07-17T10:12:49.000Z',
    followers: 1189,
    following: 16,
    posts: 715,
    markdown:
      'The credit layer for the agentic economy. Credit is an invaluable tool for growth. This is doubly important in the Agentic Economy, where strategies scale with capital. Our architecture extends underwritten credit lines and risk-adjusted leverage through verifiable credit.'
  });
});

test('builds a specific AI infrastructure narrative and dev profile', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0xa22e9c5d458277f6ebb99e92f065a4a443344ba3',
      symbol: 'Monid',
      name: 'MonidAI'
    },
    market: {
      priceUsd: 0.0000003316,
      marketCapUsd: 33166,
      liquidityUsd: 32809.24,
      volume24h: 95785.78,
      websites: [{ url: 'https://monid.ai/', label: 'Website' }],
      socials: [{ url: 'https://x.com/monid_ai', type: 'twitter' }]
    },
    sources: {
      website: {
        url: 'https://monid.ai/',
        markdown: `Monid is an agent-native router for tool calls. Your agent discovers the right endpoint and Monid routes the call. One skill, every tool your agent needs.`,
        title: 'Monid — One skill. Every tool your agent needs.',
        discoveredLinks: ['https://app.monid.ai', 'https://docs.monid.ai']
      },
      xProfile: {
        url: 'https://x.com/monid_ai',
        displayName: 'Monid',
        handle: '@monid_ai',
        bio: 'One skill, every tool your agent needs.',
        joined: 'March 2026',
        followers: 425,
        posts: 29
      },
      bankr: {
        url: 'https://bankr.bot/launches/0xa22e9c5d458277f6ebb99e92f065a4a443344ba3',
        feeRecipientWallet: '0xc403310ccf4ce8668610f79adf9832c2beea62bf',
        feeRecipientHandle: null,
        feeRecipientUrl: null
      }
    }
  });

  assert.equal(profile.narrative.category, 'AI');
  assert.equal(profile.narrative.label, 'AI工具路由');
  assert.match(profile.narrative.thesis, /tool calls|router|工具|路由/i);
  assert.match(profile.narrative.origin, /叙事核心|agent|工具|路由|社区期待|风险/i);
  assert.deepEqual(
    profile.narrative.details.map((item) => item.label),
    ['叙事核心（社区主推版本）', 'Dev 背书 + 社区期待', '风险/未确认']
  );
  assert.match(profile.narrative.details.map((item) => item.value).join('\n'), /agent-native router|tool calls|endpoint|按调用|MCP|早期/i);
  assert.equal(profile.dev.publicHandle, '@monid_ai');
  assert.equal(profile.dev.feeRecipientWallet, '0xc403310ccf4ce8668610f79adf9832c2beea62bf');
  assert.equal(profile.dev.identityStatus, '部分确认');
  assert.match(profile.dev.aiLevel, /小号|新号|未确认|followers|粉丝/i);
  assert.match(profile.dev.cryptoLevel, /Bankr|链上|发行|未确认/i);
});

test('uses Bankr fee recipient X handle as the dev signal for bond.credit', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0xca2c020d4572f7de62c051e2aa95b8cfeae4dba3',
      symbol: 'BOND',
      name: 'bond.credit'
    },
    market: {
      priceUsd: 0.000003124,
      marketCapUsd: 312487,
      liquidityUsd: 158215.53,
      volume24h: 703606.33,
      websites: [],
      socials: []
    },
    sources: {
      xProfile: {
        url: 'https://x.com/bondoncredit',
        displayName: 'bond.credit',
        handle: '@bondoncredit',
        bio: 'The credit layer for the agentic economy.',
        markdown:
          'The credit layer for the agentic economy. underwritten credit lines, risk-adjusted leverage through verifiable credit. ERC-8004 Builder Community Call.'
      },
      bankr: {
        url: 'https://bankr.bot/launches/0xca2c020d4572f7de62c051e2aa95b8cfeae4dba3',
        tokenName: 'bond.credit',
        feeRecipientWallet: '0x20c1e69a5af8044e8ad8f7e26e2ac478ea4d8d8d',
        feeRecipientHandle: '@bondoncredit',
        feeRecipientUrl: 'https://x.com/bondoncredit',
        deployerWallet: '0xb1c6cc3e066175c5b3237cb6af73616162e890da',
        deployerHandle: '@papaldo2614'
      }
    }
  });

  assert.equal(profile.narrative.category, 'AI');
  assert.equal(profile.narrative.label, 'Agent信用/AI金融');
  assert.match(profile.narrative.origin, /信用|承销|杠杆|verifiable credit|ERC-8004|技术含量|短板/i);
  assert.equal(profile.dev.publicHandle, '@bondoncredit');
  assert.equal(profile.dev.feeRecipientHandle, '@bondoncredit');
  assert.equal(profile.dev.feeRecipientWallet, '0x20c1e69a5af8044e8ad8f7e26e2ac478ea4d8d8d');
  assert.equal(profile.dev.identityStatus, 'Fee Recipient确认');
  assert.match(profile.dev.who, /Fee Recipient|@bondoncredit|收益接收方/);
  assert.match(profile.dev.aiLevel, /AI金融|产品|早期|团队|未看到/i);
  assert.match(profile.dev.cryptoLevel, /早期|Bankr|链上|发行|未看到/i);
});

test('grades RepoPrompt dev by public AI and crypto reputation signals', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x9b92d189a80d70a4bb5d8ac02e25b59b7f0c8ba3',
      symbol: 'REPO',
      name: 'RepoPrompt'
    },
    market: {
      priceUsd: 0.000001,
      marketCapUsd: 120000,
      liquidityUsd: 45000,
      volume24h: 100000,
      websites: [{ url: 'https://repoprompt.com/', label: 'Website' }],
      socials: []
    },
    sources: {
      xProfile: {
        url: 'https://x.com/pvncher',
        displayName: 'eric provencher',
        handle: '@pvncher',
        bio: 'building @repoprompt | prev Staff Eng working on XR @unity',
        joined: '2013-06-29T22:08:45.000Z',
        followers: 23777,
        following: 4692,
        posts: 16455,
        markdown:
          'building @repoprompt | prev Staff Eng working on XR @unity As models get smarter and more capable, you will get diminishing returns prompting them yourself. Enter Orchestrate a powerful new workflow that allows you to combine the strengths of GPT 5.5 and Opus 4.7. As a developer of an mcp server... This is why I built repo prompt. You can’t just put the whole codebase into the model’s context. I added codemaps.'
      },
      bankr: {
        url: 'https://bankr.bot/launches/0x9b92d189a80d70a4bb5d8ac02e25b59b7f0c8ba3',
        tokenName: 'RepoPrompt',
        feeRecipientWallet: '0x19920784fb1910b1903cc80165b2350a3f55a447',
        feeRecipientHandle: '@pvncher',
        feeRecipientUrl: 'https://x.com/pvncher',
        deployerWallet: '0x0c7e483f60163cbd9aa24e85a7ab9cd9fe1b82e0',
        deployerHandle: '@hyporliquid'
      },
      website: {
        url: 'https://repoprompt.com/',
        markdown:
          'RepoPrompt helps agents and coding models understand repositories with MCP server, codemaps, prompts and selective context.'
      }
    }
  });

  assert.equal(profile.dev.publicHandle, '@pvncher');
  assert.equal(profile.narrative.label, 'AI工具/代码上下文');
  assert.match(profile.narrative.origin, /RepoPrompt|代码库|MCP|codemaps|selective context|叙事核心|风险/i);
  assert.match(profile.narrative.details.map((item) => item.value).join('\n'), /coding models|repositories|MCP|codemaps|上下文|工作流/i);
  assert.match(profile.dev.background, /Staff Eng|Unity|RepoPrompt|MCP/i);
  assert.match(profile.dev.aiLevel, /二线偏强|AI 工具|MCP|RepoPrompt|Staff Eng|2\.38万粉/i);
  assert.match(profile.dev.cryptoLevel, /三线|早期|Bankr|Fee Recipient|币圈原生/i);
  assert.match(profile.dev.evidence.join('\n'), /X 粉丝约 2\.38万|Unity|MCP|codemaps|Bankr/);
});

test('explains LibreChat as an open-source AI chat platform, not RepoPrompt code context', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x7791b1fd1b973c4f5bc01281fca8f1301e0bdba3',
      symbol: 'LibreChat',
      name: 'LibreChat'
    },
    market: {
      websites: [],
      socials: []
    },
    sources: {
      website: {
        url: 'https://github.com/danny-avila/LibreChat',
        title:
          'GitHub - danny-avila/LibreChat: Enhanced ChatGPT Clone: Features Agents, MCP, DeepSeek, Anthropic, OpenAI, GPT-5, Mistral, OpenRouter, Code Interpreter, open-source for self-hosting.',
        markdown:
          'LibreChat is a self-hosted AI chat platform that unifies major AI providers in a single privacy-focused interface. Features include AI model selection, custom endpoints, LibreChat Agents, MCP support, Code Interpreter API, web search, artifacts, image generation, presets, multimodal file interactions, multi-user secure authentication and open-source self-hosting.'
      },
      xProfile: {
        url: 'https://x.com/lgtm_hbu',
        displayName: 'Danny Avila',
        handle: '@lgtm_hbu',
        bio: 'Founder | Software Engineer | AI Enthusiast Owner & Maintainer of LibreChat Building in public: github.com/danny-avila/',
        followers: 764
      },
      github: {
        user: {
          login: 'danny-avila',
          name: null,
          bio: null,
          company: null,
          followers: null,
          publicRepos: null,
          url: 'https://github.com/danny-avila'
        },
        repos: [
          {
            name: 'LibreChat',
            fullName: 'danny-avila/LibreChat',
            description:
              'Enhanced ChatGPT Clone: Features Agents, MCP, DeepSeek, Anthropic, OpenAI, GPT-5, Mistral, OpenRouter, Code Interpreter, open-source for self-hosting.',
            stars: null,
            forks: null,
            language: null,
            url: 'https://github.com/danny-avila/LibreChat'
          }
        ],
        topRepoReadme:
          'LibreChat is a self-hosted AI chat platform with model switching, custom endpoints, LibreChat Agents, MCP support, Code Interpreter API, web search, artifacts, multimodal files, multi-user auth, presets and open-source self-hosting.'
      },
      bankr: {
        url: 'https://bankr.bot/launches/0x7791b1fd1b973c4f5bc01281fca8f1301e0bdba3',
        tokenName: 'LibreChat',
        tokenSymbol: 'LibreChat',
        feeRecipientHandle: '@lgtm_hbu',
        feeRecipientWallet: '0xab5370647c2ace112070fab0b7fd08de8c05c8d7',
        websiteUrl: 'https://github.com/danny-avila/LibreChat'
      }
    }
  });

  assert.equal(profile.narrative.label, '开源AI聊天平台');
  assert.match(profile.narrative.details[0].value, /self-hosted|AI chat|model|Agents|MCP|Code Interpreter|open-source/i);
  assert.match(profile.dev.aiLevel, /LibreChat|开源|AI chat|MCP|Code Interpreter|早期/i);
  assert.doesNotMatch(profile.narrative.origin, /RepoPrompt|代码上下文|codemaps|selective context/i);
});

test('keeps source links focused on useful evidence instead of every discovered docs page', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x7791b1fd1b973c4f5bc01281fca8f1301e0bdba3',
      symbol: 'LibreChat',
      name: 'LibreChat'
    },
    market: {
      pairUrl: 'https://dexscreener.com/base/0x5a0e52d18f87c19886e2f47a196adf02fa72aff14bda50b59645c98ff7290b00',
      websites: [],
      socials: []
    },
    sources: {
      website: {
        url: 'https://github.com/danny-avila/LibreChat',
        markdown:
          'LibreChat is a self-hosted AI chat platform with Agents, MCP support, Code Interpreter API and open-source self-hosting.',
        discoveredLinks: [
          'https://librechat.ai',
          'https://discord.librechat.ai',
          'https://docs.librechat.ai',
          'https://www.librechat.ai/docs/translation',
          'https://www.librechat.ai/docs/features/code_interpreter',
          'https://www.librechat.ai/docs/features/agents',
          'https://www.librechat.ai/docs/features/skills',
          'https://www.librechat.ai/docs/features/subagents',
          'https://www.librechat.ai/docs/features/web_search',
          'https://librechat.ai/blog',
          'https://www.librechat.ai/changelog'
        ]
      },
      xProfile: {
        url: 'https://x.com/lgtm_hbu',
        displayName: 'Danny Avila',
        handle: '@lgtm_hbu',
        bio: 'Founder | Software Engineer | AI Enthusiast Owner & Maintainer of LibreChat',
        followers: 764
      },
      github: {
        user: {
          login: 'danny-avila',
          url: 'https://github.com/danny-avila'
        },
        repos: [
          {
            name: 'LibreChat',
            fullName: 'danny-avila/LibreChat',
            description: 'Enhanced ChatGPT Clone: Features Agents, MCP, Code Interpreter, open-source for self-hosting.',
            url: 'https://github.com/danny-avila/LibreChat'
          }
        ]
      },
      bankr: {
        url: 'https://bankr.bot/launches/0x7791b1fd1b973c4f5bc01281fca8f1301e0bdba3',
        tokenName: 'LibreChat',
        tokenSymbol: 'LibreChat',
        feeRecipientHandle: '@lgtm_hbu',
        feeRecipientUrl: 'https://x.com/lgtm_hbu',
        websiteUrl: 'https://github.com/danny-avila/LibreChat'
      }
    }
  });

  assert.ok(profile.sourceLinks.length <= 12);
  assert.ok(profile.sourceLinks.includes('https://bankr.bot/launches/0x7791b1fd1b973c4f5bc01281fca8f1301e0bdba3'));
  assert.ok(profile.sourceLinks.includes('https://x.com/lgtm_hbu'));
  assert.ok(profile.sourceLinks.includes('https://github.com/danny-avila/LibreChat'));
  assert.ok(profile.sourceLinks.includes('https://librechat.ai'));
  assert.ok(profile.sourceLinks.includes('https://docs.librechat.ai'));
  assert.doesNotMatch(profile.sourceLinks.join('\n'), /translation|features\/code_interpreter|features\/agents|features\/skills|changelog/i);
});

test('does not turn a security researcher bio into a generic AI app narrative', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x68f073bb70f3c8ba44f00acdb17f36d67019fba3',
      symbol: 'OhMyPi',
      name: 'OhMyPi'
    },
    market: {
      websites: [],
      socials: []
    },
    sources: {
      xProfile: {
        url: 'https://x.com/_can1357',
        displayName: 'Can Bölük',
        handle: '@_can1357',
        bio:
          'Security researcher and reverse engineer. Interested in Windows kernel development, low-level programming, static program analysis and cryptography.',
        followers: 8732
      },
      bankr: {
        url: 'https://bankr.bot/launches/0x68f073bb70f3c8ba44f00acdb17f36d67019fba3',
        tokenName: 'OhMyPi',
        tokenSymbol: 'OhMyPi',
        feeRecipientHandle: '@_can1357',
        feeRecipientWallet: '0x17daf5557988677f6fa13bdab1c64c0c12d523d2',
        deployerHandle: '@0xAdopter'
      }
    }
  });

  assert.equal(profile.narrative.label, '安全研究者meme');
  assert.match(profile.narrative.details[0].value, /security researcher|reverse engineer|Windows kernel|static program analysis|cryptography/i);
  assert.match(profile.dev.aiLevel, /不是典型 AI 圈|安全研究|逆向|Windows kernel/i);
  assert.doesNotMatch(profile.narrative.origin, /AI 应用\/agent 工作流|model routing|inference|automation/i);
});

test('filters fake version hostnames from source links even when GitHub homepage contains them', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x68f073bb70f3c8ba44f00acdb17f36d67019fba3',
      symbol: 'OhMyPi',
      name: 'OhMyPi'
    },
    market: {
      websites: [],
      socials: []
    },
    sources: {
      xProfile: {
        url: 'https://x.com/_can1357',
        displayName: 'Can Bölük',
        handle: '@_can1357',
        bio:
          'Security researcher and reverse engineer. Interested in Windows kernel development, low-level programming, static program analysis and cryptography.',
        followers: 8732
      },
      github: {
        user: {
          login: 'can1357',
          url: 'https://github.com/can1357'
        },
        repos: [
          {
            name: 'oh-my-pi',
            fullName: 'can1357/oh-my-pi',
            description: 'A Windows exploit and low-level programming project.',
            url: 'https://github.com/can1357/oh-my-pi',
            homepage: 'https://notepad.exe'
          }
        ]
      },
      bankr: {
        url: 'https://bankr.bot/launches/0x68f073bb70f3c8ba44f00acdb17f36d67019fba3',
        tokenName: 'OhMyPi',
        tokenSymbol: 'OhMyPi',
        feeRecipientHandle: '@_can1357',
        feeRecipientWallet: '0x17daf5557988677f6fa13bdab1c64c0c12d523d2',
        deployerHandle: '@0xAdopter'
      }
    }
  });

  assert.doesNotMatch(profile.sourceLinks.join('\n'), /https:\/\/(?:3\.x|notepad\.exe)/i);
  assert.ok(profile.sourceLinks.includes('https://github.com/can1357/oh-my-pi'));
});

test('explains human.cv as an authorship and human proof product, not an unresolved meme', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0xc53f0bfb346ab19ecdcb540a4aa560448be85ba3',
      symbol: 'HUMAN',
      name: 'human.cv'
    },
    market: {
      websites: [{ url: 'https://human.cv/', label: 'Website' }],
      socials: []
    },
    sources: {
      website: {
        url: 'https://human.cv/',
        title: 'human.cv — proof that I made it',
        markdown:
          'human.cv — proof that I made it. A protocol for proving, permanently and verifiably, that what you made is yours. The on-chain résumé of a verified human.'
      },
      xProfile: {
        url: 'https://x.com/humandotcv',
        displayName: 'human.cv',
        handle: '@humandotcv',
        bio: 'proof that I made it. on-chain résumé of a verified human.',
        followers: 572
      },
      bankr: {
        url: 'https://bankr.bot/launches/0xc53f0bfb346ab19ecdcb540a4aa560448be85ba3',
        tokenName: 'human.cv',
        tokenSymbol: 'HUMAN',
        feeRecipientHandle: '@humandotcv',
        feeRecipientUrl: 'https://x.com/humandotcv',
        feeRecipientWallet: '0x1111111111111111111111111111111111111111',
        deployerHandle: '@rumidotsol',
        websiteUrl: 'https://human.cv/'
      }
    }
  });

  assert.equal(profile.narrative.category, 'Product');
  assert.equal(profile.narrative.label, '人类身份/创作证明');
  assert.match(profile.narrative.details[0].value, /proof that I made it|proving|made is yours|on-chain résumé|verified human|创作|归属/i);
  assert.match(profile.dev.aiLevel, /不是典型 AI 圈|身份|创作证明|产品/i);
  assert.match(profile.dev.cryptoLevel, /Bankr Fee Recipient|@humandotcv|早期|链上发行/i);
  assert.doesNotMatch(profile.narrative.origin, /目前没有抓到明确产品锚点|原梗|Meme/i);
});

test('explains AURA as a DeFi analyst-backed Bankr meme, not a generic unresolved meme', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x4832698221091cc869cb9329dd0e5eb9f3796ba3',
      symbol: 'AURA',
      name: 'Aurapay'
    },
    market: {
      websites: [],
      socials: []
    },
    sources: {
      xProfile: {
        url: 'https://x.com/0xSireal',
        displayName: 'Sireal',
        handle: '@0xSireal',
        bio: 'Onchain Liquidity & Retention Analyst | Defi Educator | Researcher | @dune wizard | Writer | Ghostwriter',
        followers: 2875
      },
      bankr: {
        url: 'https://bankr.bot/launches/0x4832698221091cc869cb9329dd0e5eb9f3796ba3',
        tokenName: 'Aurapay',
        tokenSymbol: 'AURA',
        feeRecipientHandle: '@0xSireal',
        feeRecipientUrl: 'https://x.com/0xSireal',
        feeRecipientWallet: '0x2222222222222222222222222222222222222222',
        deployerHandle: '@mitom_cucu',
        tweetUrl: 'https://x.com/0xSireal/status/2058891430060544365'
      }
    }
  });

  assert.equal(profile.narrative.category, 'Meme');
  assert.equal(profile.narrative.label, '链上分析师meme');
  assert.match(profile.narrative.details[0].value, /Onchain Liquidity|Retention Analyst|DeFi Educator|Dune|分析师|Aurapay/i);
  assert.match(profile.dev.aiLevel, /不是典型 AI 圈|链上流动性|Dune|DeFi/i);
  assert.match(profile.dev.cryptoLevel, /DeFi|Dune|链上分析|Bankr Fee Recipient|@0xSireal/i);
  assert.doesNotMatch(profile.narrative.origin, /目前没有抓到明确产品锚点|原梗|AI 应用/i);
});

test('explains Stargaze as physical AI attestation infrastructure, not generic AI app text', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0xf10500ebdb281a73bc19979bfceb45b1a7a01b07',
      symbol: 'STARGAZE',
      name: 'Stargaze'
    },
    market: {
      pairName: 'STARGAZE/WETH',
      websites: [{ url: 'https://stargaze.cc/', label: 'Website' }],
      socials: [{ url: 'https://x.com/StargazeBASE', type: 'twitter' }]
    },
    sources: {
      website: {
        url: 'https://stargaze.cc/',
        title: 'Stargaze',
        markdown:
          'Stargaze Verification infrastructure for physical AI. Prove what your machines did. Reveal nothing else. Physical AI that can prove it was there, without revealing where. Stargaze turns a claim about data into independently verifiable evidence while raw telemetry stays confidential. On-chain attestation on Ethereum Attestation Service and Base. Zero-knowledge verification with Groth16 proofs. Hardware root of trust secure-element signing. Economic assurance with reputation and staking. Built for UAV drone operators, robotics and autonomous logistics, DePIN networks, insurers and regulators.'
      },
      xProfile: {
        url: 'https://x.com/StargazeBASE',
        displayName: 'Stargaze',
        handle: '@StargazeBASE',
        bio:
          'Private, verifiable attestations for physical AI, on Base | Prove that your devices were there, without revealing where.',
        followers: 150
      },
      github: {
        user: {
          login: 'StargazeBASE',
          name: 'StargazeBASE',
          followers: 1,
          publicRepos: 2,
          url: 'https://github.com/StargazeBASE'
        },
        repos: [
          {
            name: 'Stargaze',
            fullName: 'StargazeBASE/Stargaze',
            description: 'Stargaze — private, verifiable attestations for physical AI, on Base (EAS + ZK).',
            stars: 0,
            forks: 0,
            language: 'TypeScript',
            url: 'https://github.com/StargazeBASE/Stargaze'
          }
        ]
      }
    }
  });

  assert.equal(profile.narrative.category, 'AI');
  assert.equal(profile.narrative.label, 'Physical AI验证');
  assert.match(profile.narrative.details[0].value, /physical AI|attestation|EAS|Base|Groth16|secure-element|staking|DePIN|drone/i);
  assert.match(profile.dev.aiLevel, /Physical AI|验证|ZK|EAS|小号|早期/i);
  assert.match(profile.dev.cryptoLevel, /Base|EAS|链上证明|Bankr|未确认/i);
  assert.doesNotMatch(profile.narrative.origin, /agent、automation、research、inference、workflow 或 model routing|AI 应用\/agent 工作流项目币/i);
});

test('explains ECC as an AI agent harness, not Stargaze physical AI', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x9f5128cf058526c8480d1665ef5c63dc241b9ba3',
      symbol: 'ECC',
      name: 'ECC Tools'
    },
    market: {
      pairName: 'ECC/WETH',
      pairUrl: 'https://dexscreener.com/base/0x141a13df49242e1a57f520dc0eccd64d07ab79f121e2b4569c54e88c7a290886',
      websites: [],
      socials: []
    },
    sources: {
      website: {
        url: 'https://github.com/affaan-m/ECC',
        title:
          'GitHub - affaan-m/ECC: The agent harness performance optimization system. Skills, instincts, memory, security, and research-first development for Claude Code, Codex, Opencode, Cursor and beyond.',
        markdown:
          'The agent harness performance optimization system. Skills, instincts, memory, security, and research-first development for Claude Code, Codex, Opencode, Cursor and beyond. OSS Agent Meta-Harness. Skills, instincts, memory, MCP, codemaps, security and research-first development.',
        discoveredLinks: [
          'https://x.com/affaanmustafa/status/2012378465664745795',
          'https://x.com/affaanmustafa/status/2014040193557471352',
          'https://x.com/affaanmustafa/status/2033263813387223421',
          'https://x.com/DRodriguezFX'
        ]
      },
      xProfile: {
        url: 'https://x.com/affaanmustafa',
        displayName: 'cogsec',
        handle: '@affaanmustafa',
        bio:
          'ETFs for Prediction Markets @ito_markets | Creator of ECC: The OSS Agent Meta-Harness (#25 GH)',
        followers: 31147
      },
      github: {
        user: {
          login: 'affaan-m',
          name: 'Affaan Mustafa',
          bio: 'Institutionalizing prediction markets @Ito-Markets | OSS meta-harness for AI agents @ECC-Tools',
          company: 'Ito',
          followers: 5930,
          publicRepos: 26,
          url: 'https://github.com/affaan-m'
        },
        repos: [
          {
            name: 'ECC',
            fullName: 'affaan-m/ECC',
            description:
              'The agent harness performance optimization system. Skills, instincts, memory, security, and research-first development for Claude Code, Codex, Opencode, Cursor and beyond.',
            stars: 191750,
            forks: 29680,
            language: 'Python',
            url: 'https://github.com/affaan-m/ECC',
            homepage: 'https://ecc.tools'
          },
          {
            name: 'agentshield',
            fullName: 'affaan-m/agentshield',
            description: 'AI agent security scanner for agent configurations, MCP servers, and tool permissions.',
            stars: 687,
            forks: 142,
            language: 'Python',
            url: 'https://github.com/affaan-m/agentshield'
          }
        ],
        topRepoReadme:
          'ECC is the OSS Agent Meta-Harness: skills, instincts, memory, security, MCP, codemaps and research-first development for Claude Code, Codex, Opencode, Cursor and beyond.'
      },
      bankr: {
        url: 'https://bankr.bot/launches/0x9f5128cf058526c8480d1665ef5c63dc241b9ba3',
        tokenName: 'ECC Tools',
        tokenSymbol: 'ECC',
        feeRecipientHandle: '@affaanmustafa',
        feeRecipientUrl: 'https://x.com/affaanmustafa',
        feeRecipientWallet: '0x0fc7d3fb3a56019a1c47b88a4b6faaeaaf73b0b5',
        deployerHandle: '@eeunqbla',
        tweetUrl: 'https://x.com/affaanmustafa/status/2040271822902694006',
        websiteUrl: 'https://github.com/affaan-m/ECC'
      }
    }
  });

  assert.equal(profile.narrative.category, 'AI');
  assert.equal(profile.narrative.label, 'AI Agent工具框架');
  assert.match(profile.narrative.details[0].value, /agent harness|OSS Agent Meta-Harness|Claude Code|Codex|skills|instincts|memory|MCP|codemaps/i);
  assert.match(profile.dev.aiLevel, /Affaan Mustafa|ECC|agent|Claude Code|Codex|3\.11万粉|GitHub/i);
  assert.match(profile.dev.cryptoLevel, /prediction markets|Ito|Bankr Fee Recipient|@affaanmustafa|早期/i);
  assert.doesNotMatch(profile.narrative.origin, /Stargaze|Physical AI|Groth16|secure-element|EAS/i);
  assert.ok(profile.sourceLinks.length <= 12);
  assert.doesNotMatch(profile.sourceLinks.join('\n'), /2012378465664745795|2014040193557471352|2033263813387223421|DRodriguezFX/i);
});

test('explains LocalAI as an open-source local inference stack, not generic AI app text', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x905bc4f1e4ece2ff2d46e6d6e7934bc6610c0ba3',
      symbol: 'LocalAI',
      name: 'LocalAI'
    },
    market: {
      pairName: 'LocalAI/WETH',
      pairUrl: 'https://dexscreener.com/base/0x0d5bd2c9188ec4df81019fbb1eb4bc81542593c261fc0dcf16f7805808d7a67b',
      websites: [{ url: 'https://localai.io', label: 'Website' }],
      socials: []
    },
    sources: {
      website: {
        url: 'https://localai.io',
        title: 'LocalAI - The free, OpenAI, Anthropic alternative. Your All-in-One Complete AI Stack',
        markdown:
          'The free, OpenAI, Anthropic alternative. Your All-in-One Complete AI Stack. Run powerful language models, audio, image generation and embeddings locally or on-prem. LocalAI is an OpenAI-compatible REST API for local inference with no GPU required, model galleries and Docker/Kubernetes deployment.',
        discoveredLinks: ['https://models.localai.io']
      },
      xProfile: {
        url: 'https://x.com/mudler_it',
        displayName: 'Ettore Di Giacinto',
        handle: '@mudler_it',
        bio: 'Founder of LocalAI. Open-source, Linux, Kubernetes and AI infrastructure builder.',
        followers: 14600
      },
      github: {
        user: {
          login: 'mudler',
          name: 'Ettore Di Giacinto',
          bio: 'Open-source maintainer. LocalAI creator.',
          followers: 3100,
          publicRepos: 120,
          url: 'https://github.com/mudler'
        },
        repos: [
          {
            name: 'LocalAI',
            fullName: 'mudler/LocalAI',
            description:
              'LocalAI is the free, OpenAI compatible alternative. Run LLMs, image generation, audio and embeddings locally.',
            stars: 39400,
            forks: 3000,
            language: 'Go',
            url: 'https://github.com/mudler/LocalAI',
            homepage: 'https://localai.io'
          }
        ],
        topRepoReadme:
          'LocalAI is a drop-in replacement REST API compatible with OpenAI API specifications for local inferencing. It runs LLMs, image generation, audio and embeddings locally, on-prem and in Docker/Kubernetes.'
      },
      bankr: {
        url: 'https://bankr.bot/launches/0x905bc4f1e4ece2ff2d46e6d6e7934bc6610c0ba3',
        tokenName: 'LocalAI',
        tokenSymbol: 'LocalAI',
        feeRecipientHandle: '@mudler_it',
        feeRecipientUrl: 'https://x.com/mudler_it',
        feeRecipientWallet: '0x60cfda537c4f5590b0047fd7fa92ee268e483a58',
        tweetUrl: 'https://x.com/mudler_it/status/2058148495081509341',
        websiteUrl: 'https://localai.io'
      }
    }
  });

  assert.equal(profile.narrative.category, 'AI');
  assert.equal(profile.narrative.label, '开源本地AI推理栈');
  assert.match(profile.narrative.details[0].value, /LocalAI|OpenAI-compatible|local inference|本地|LLM|image|audio|embeddings|Docker|Kubernetes/i);
  assert.match(profile.dev.aiLevel, /Ettore|LocalAI|开源|推理|基础设施|1\.46万粉|GitHub/i);
  assert.match(profile.dev.cryptoLevel, /Bankr Fee Recipient|@mudler_it|早期|AI infra/i);
  assert.doesNotMatch(profile.narrative.origin, /agent、automation、research、inference、workflow 或 model routing|AI 应用\/agent 工作流项目币/i);
  assert.ok(profile.sourceLinks.includes('https://localai.io'));
  assert.ok(profile.sourceLinks.includes('https://models.localai.io'));
});

test('grades paoloanzn by GitHub open-source AI builder evidence', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x67a7ca081dc79b45fd1fa059cd3b8dcca779aba3',
      symbol: 'FreeCode',
      name: 'FreeCode'
    },
    market: {
      websites: [],
      socials: []
    },
    sources: {
      xProfile: {
        url: 'https://x.com/paoloanzn',
        displayName: '4nzn',
        handle: '@paoloanzn',
        bio: 'Founder @Gladium-AI | building agentic AI and automation',
        followers: 23000,
        markdown:
          'Founder @Gladium-AI. I built free-code, the free build of Claude Code. Build on Base? possibly.'
      },
      github: {
        user: {
          login: 'paoloanzn',
          name: 'Paolo Anzani',
          bio: 'Founder @Gladium-AI',
          company: 'Gladium AI',
          followers: 295,
          publicRepos: 18,
          url: 'https://github.com/paoloanzn'
        },
        repos: [
          {
            name: 'free-code',
            fullName: 'paoloanzn/free-code',
            description:
              'The free build of Claude Code. All telemetry removed, security-prompt guardrails stripped, all experimental features enabled.',
            stars: 8383,
            forks: 1992,
            language: 'TypeScript',
            url: 'https://github.com/paoloanzn/free-code'
          },
          {
            name: 'free-solscan-api',
            fullName: 'paoloanzn/free-solscan-api',
            description: 'Solscan 200$/mo API, reversed engineered for FREE.',
            stars: 162,
            forks: 46,
            language: 'Python',
            url: 'https://github.com/paoloanzn/free-solscan-api'
          }
        ],
        topRepoReadme:
          'free-code: A clean, buildable fork of Anthropic Claude Code CLI. All telemetry stripped. All guardrails removed. All experimental features unlocked. Supports Anthropic, OpenAI Codex, Bedrock and Vertex providers.'
      },
      bankr: {
        url: 'https://bankr.bot/launches/0x67a7ca081dc79b45fd1fa059cd3b8dcca779aba3',
        feeRecipientHandle: '@paoloanzn',
        feeRecipientWallet: '0x1111111111111111111111111111111111111111'
      }
    }
  });

  assert.equal(profile.dev.publicHandle, '@paoloanzn');
  assert.equal(profile.narrative.label, 'AI dev meme');
  assert.match(profile.narrative.thesis, /这个 CA（0x67a7ca081dc79b45fd1fa059cd3b8dcca779aba3）是 Base 链上的.*meme coin.*\$FreeCode/i);
  assert.deepEqual(
    profile.narrative.details.map((item) => item.label),
    ['叙事核心（社区主推版本）', 'Dev 背书 + 社区期待', '风险/未确认']
  );
  assert.match(profile.narrative.details[0].value, /Claude Code|Anthropic|free-code|代码自由|反限制|开源编码工具/i);
  assert.match(profile.narrative.details[1].value, /@paoloanzn|Paolo Anzani|Gladium AI|8\.38k stars|Bankr Fee Recipient/i);
  assert.match(profile.dev.background, /Paolo Anzani|Gladium AI|free-code|Claude Code|GitHub/i);
  assert.match(profile.dev.aiLevel, /中上|开源实干派|AI 创业者|free-code|Claude Code|8\.38k stars|Gladium/i);
  assert.match(profile.dev.cryptoLevel, /新晋关注|老用户|Base|Bankr|AI dev 跨界|尚未看到/i);
  assert.match(profile.dev.evidence.join('\n'), /GitHub：paoloanzn|free-code|8\.38k stars|1\.99k forks|free-solscan-api|Gladium AI/i);
  assert.ok(profile.sourceLinks.includes('https://github.com/paoloanzn'));
  assert.ok(profile.sourceLinks.includes('https://github.com/paoloanzn/free-code'));
});

test('writes Katch narrative in clear community-meme research style', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0xd570281a7595faa936acf7aa3e3eaae7f476eba3',
      symbol: 'Katch',
      name: 'Katch live'
    },
    market: {
      websites: [],
      socials: []
    },
    sources: {
      xProfile: {
        url: 'https://x.com/Katch_live',
        displayName: 'Katch',
        handle: '@Katch_live',
        bio: 'Real life short videos. Get paid for doing things you already do. World verified.',
        followers: 4800,
        markdown:
          'Katch_live is a real life short video app. Pick something you already do, record a 1 minute video and get paid. World verification supported. Thousands of users.'
      },
      bankr: {
        url: 'https://bankr.bot/launches/0xd570281a7595faa936acf7aa3e3eaae7f476eba3',
        tokenName: 'Katch live',
        tokenSymbol: 'Katch',
        chain: 'base',
        feeRecipientWallet: '0x73d1415b5fed15639bd568656ae460f2f3ddf361',
        feeRecipientHandle: '@Katch_live',
        feeRecipientUrl: 'https://x.com/Katch_live',
        deployerWallet: '0x880c0de96211a6a22eb09997ed8fb0b0d6b449f1',
        deployerHandle: '@DimaLoord',
        tweetUrl: 'https://x.com/Flynnjamm/status/2046625126142341505?s=20'
      }
    }
  });

  assert.equal(profile.narrative.label, '社区产品 meme');
  assert.match(profile.narrative.thesis, /这个 CA（0xd570281a7595faa936acf7aa3e3eaae7f476eba3）是 Base 链上的.*\$Katch/i);
  assert.deepEqual(
    profile.narrative.details.map((item) => item.label),
    ['叙事核心（社区主推版本）', 'Dev 背书 + 社区期待', '风险/未确认']
  );
  assert.match(profile.narrative.details[0].value, /Katch_live|真实生活|短视频|赚钱|World|Web3 版生活记录/i);
  assert.match(profile.narrative.details[1].value, /@DimaLoord|@Katch_live|@Flynnjamm|Bankr|dev-backed|认领手续费|社区/i);
  assert.match(profile.narrative.details[2].value, /未确认|社区驱动|预期|正式支持/i);
});

test('does not confuse plannotator with the FreeCode narrative', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0xe115314e331537ec8be34c8329639e1228520ba3',
      symbol: 'PLAN',
      name: 'plannotator'
    },
    market: {
      pairUrl: 'https://dexscreener.com/base/0x859a683eb14e29bb487c3ae0a748b92f5d5f87eccf148adcd7424a9bb0995669',
      pairName: 'PLAN/WETH',
      quoteTokenSymbol: 'WETH',
      websites: [],
      socials: []
    },
    sources: {
      website: {
        url: 'https://github.com/backnotprop/plannotator',
        title:
          'GitHub - backnotprop/plannotator: Annotate and review coding agent plans and code diffs visually, share with your team, send feedback to agents with one click.',
        markdown:
          'Interactive Plan & Code Review for AI Coding Agents. Mark up and refine your plans or code diffs using a visual UI, share for team collaboration, and seamlessly integrate with Claude Code, Copilot CLI, Gemini CLI, OpenCode, Pi, Codex, and Droid. Plan Mode Demos: Annotate plans, specs, folders, files, urls. Send feedback to agents with one click.',
        discoveredLinks: [
          'https://github.com/backnotprop/plannotator',
          'https://github.githubassets.com/assets/light-74231a1f3bbb.css',
          'https://avatars.githubusercontent.com/u/123456?v=4',
          'https://api.github.com/_private/browser/stats',
          'https://github.com/backnotprop/plannotator&quot; data-view-component=&quot;true&quot;',
          'https://github-cloud.s3.amazonaws.com',
          'https://user-images.githubusercontent.com',
          'https://api.githubcopilot.com',
          'https://collector.github.com/github/collect',
          'https://opengraph.githubassets.com/5d5e5f27/backnotprop/plannotator',
          'https://github.com/backnotprop/plannotator.git',
          'https://github.com/features/copilot',
          'https://docs.github.com/get-started/accessibility/keyboard-shortcuts',
          'https://www.youtube.com/watch?v=a_AT7cEN_9I\\',
          'https://privatebin.info/',
          'https://plannotator.ai/docs/guides/sharing-and-collaboration/',
          'https://plannotator.ai/docs/guides/sharing-and-collaboration',
          'https://plannotator.ai/install.sh',
          'https://schema.org/abstract',
          'https://github.com/backnotprop/plannotator/ndroid',
          'https://x.com/backnotprop/status/2031145299738263567?s=20'
        ]
      },
      xProfile: {
        url: 'https://x.com/backnotprop',
        displayName: 'Michael Ramos',
        handle: '@backnotprop',
        bio: 'Cofounder, AI @EQTYLab / prev dc - complex systems / veteran / For fun: @plannotator',
        followers: 957,
        markdown:
          'Cofounder, AI @EQTYLab / prev dc - complex systems / veteran / For fun: @plannotator CA backnotprop.com'
      },
      bankr: {
        url: 'https://bankr.bot/launches/0xe115314e331537ec8be34c8329639e1228520ba3',
        tokenName: 'plannotator',
        tokenSymbol: 'PLAN',
        chain: 'base',
        feeRecipientWallet: '0xdac2262ea245a9b47b91260f379e58f1b5301f53',
        feeRecipientHandle: '@backnotprop',
        feeRecipientUrl: 'https://x.com/backnotprop',
        deployerWallet: '0x0c7e483f60163cbd9aa24e85a7ab9cd9fe1b82e0',
        deployerHandle: '@hyporliquid',
        tweetUrl: 'https://x.com/backnotprop/status/2031145299738263567',
        websiteUrl: 'https://github.com/backnotprop/plannotator'
      },
      github: {
        user: {
          login: 'backnotprop',
          name: 'Michael Ramos',
          bio: 'AI devtools and complex systems',
          company: 'EQTYLab',
          followers: 540,
          publicRepos: 42,
          url: 'https://github.com/backnotprop'
        },
        repos: [
          {
            name: 'plannotator',
            fullName: 'backnotprop/plannotator',
            description:
              'Annotate and review coding agent plans and code diffs visually, share with your team, send feedback to agents with one click.',
            stars: 5580,
            forks: 382,
            language: 'TypeScript',
            url: 'https://github.com/backnotprop/plannotator',
            homepage: 'https://plannotator.ai'
          },
          {
            name: 'rg_history',
            fullName: 'backnotprop/rg_history',
            description: 'Unrelated shell helper.',
            stars: 2,
            forks: 0,
            language: 'Shell',
            url: 'https://github.com/backnotprop/rg_history',
            homepage: 'https://prompttower.com'
          }
        ],
        topRepoReadme:
          'Interactive Plan & Code Review for AI Coding Agents. Mark up plans and code diffs using a visual UI. Integrates with Claude Code, Copilot CLI, Gemini CLI, OpenCode, Codex, and Droid.'
      }
    }
  });

  assert.equal(profile.narrative.category, 'AI');
  assert.equal(profile.narrative.label, 'AI代码审查/计划标注');
  assert.match(profile.narrative.thesis, /plannotator|PLAN|AI coding agents|计划|代码审查/i);
  assert.match(profile.narrative.details[0].value, /plannotator|plan|code review|code diffs|visual UI|Claude Code|Copilot|Codex/i);
  assert.match(profile.narrative.details[1].value, /@backnotprop|EQTYLab|Bankr Fee Recipient|GitHub/i);
  assert.ok(profile.sourceLinks.includes('https://github.com/backnotprop/plannotator'));
  assert.ok(profile.sourceLinks.includes('https://x.com/backnotprop'));
  assert.ok(profile.sourceLinks.includes('https://bankr.bot/launches/0xe115314e331537ec8be34c8329639e1228520ba3'));
  assert.ok(profile.sourceLinks.includes('https://plannotator.ai/docs/guides/sharing-and-collaboration'));
  assert.equal(
    profile.sourceLinks.filter((url) => url.includes('plannotator.ai/docs/guides/sharing-and-collaboration')).length,
    1
  );
  assert.equal(profile.sourceLinks.filter((url) => url.includes('x.com/backnotprop/status/2031145299738263567')).length, 1);
  assert.doesNotMatch(
    profile.sourceLinks.join('\n'),
    /githubassets|avatars\.githubusercontent|api\.github\.com\/_private|&quot;|\.css|github-cloud|user-images|api\.githubcopilot|collector\.github|github\.com\/features|docs\.github|youtube|privatebin|schema\.org|\.git|install\.sh|\/ndroid/i
  );
  assert.doesNotMatch(profile.narrative.origin, /FreeCode|Paolo|free-code|代码自由|反限制/i);
  assert.equal(profile.dev.publicHandle, '@backnotprop');
  assert.match(profile.dev.background, /Michael Ramos|EQTYLab|plannotator/i);
  assert.match(profile.dev.aiLevel, /plannotator|计划标注|代码审查|AI devtools|coding agent/i);
  assert.match(profile.dev.cryptoLevel, /@backnotprop|Bankr|早期|链上发行/i);
  assert.doesNotMatch(profile.dev.aiLevel, /Paolo|Gladium|free-code|free-solscan|telemetry|guardrails/i);
  assert.doesNotMatch(profile.dev.cryptoLevel, /Paolo|Gladium|free-code|free-solscan/i);
  assert.ok(profile.sourceLinks.includes('https://github.com/backnotprop'));
  assert.doesNotMatch(profile.sourceLinks.join('\n'), /rg_history|prompttower|free-code|paoloanzn/i);
});

test('explains AI application narratives with product, innovation, technical depth and gaps', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0xaiapp',
      symbol: 'AUTO',
      name: 'AutoResearch'
    },
    market: {
      websites: [{ url: 'https://auto.example/', label: 'Website' }],
      socials: []
    },
    sources: {
      website: {
        url: 'https://auto.example/',
        markdown:
          'AutoResearch is an AI agent research automation workspace. It connects web search, inference, scheduled reports, workflow automation and model routing so analysts can monitor markets and generate research.'
      },
      xProfile: {
        handle: '@autoresearch',
        bio: 'AI research automation agents'
      }
    }
  });

  assert.equal(profile.narrative.label, 'AI研究自动化');
  assert.deepEqual(
    profile.narrative.details.map((item) => item.label),
    ['叙事核心（社区主推版本）', 'Dev 背书 + 社区期待', '风险/未确认']
  );
  assert.match(profile.narrative.origin, /叙事核心|research automation|工作流|社区期待|风险/i);
  assert.match(profile.narrative.details.map((item) => item.value).join('\n'), /研究|自动化|inference|workflow|model routing|工具链/i);
  assert.doesNotMatch(
    profile.narrative.origin,
    /AI 应用\/agent 工作流|公开资料指向 agent、automation、research、inference、workflow 或 model routing/i
  );
});

test('explains OpenAgent as a concrete coding-agent harness, not a generic AI app template', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0xopenagent',
      symbol: 'openagent',
      name: 'OpenAgent'
    },
    market: {
      websites: [{ url: 'https://ohmyopenagent.com/', label: 'Website' }],
      socials: []
    },
    sources: {
      website: {
        url: 'https://ohmyopenagent.com/',
        title: 'Oh My OpenAgent — The Best Agent Harness',
        markdown:
          'Title: Oh My OpenAgent — The Best Agent Harness | Oh My OpenAgent Markdown Content: Meet Sisyphus: The batteries-included agent that codes like you. Multi-model orchestration, Tea integration, prompt-to-code workflows, coding-agent harness and inference routing for shipping software with agents.'
      },
      xProfile: {
        handle: '@ohmyopenagent',
        bio: 'OpenAgent. Sisyphus codes like you. Multi-model coding agent harness.'
      },
      bankr: {
        url: 'https://bankr.bot/launches/0xopenagent',
        tokenName: 'OpenAgent',
        tokenSymbol: 'openagent',
        feeRecipientHandle: '@ohmyopenagent',
        websiteUrl: 'https://ohmyopenagent.com/'
      }
    }
  });

  assert.equal(profile.narrative.label, 'AI Agent编程框架');
  assert.match(profile.narrative.thesis, /OpenAgent|Sisyphus|coding-agent harness|多模型/i);
  assert.match(profile.narrative.details[0].value, /Sisyphus|batteries-included|codes like you|Multi-model orchestration|Tea integration|prompt-to-code/i);
  assert.match(profile.narrative.details[0].value, /不是泛泛的 AI 应用|coding agent|编程代理/i);
  assert.doesNotMatch(
    profile.narrative.origin,
    /AI 应用\/agent 工作流|agent、automation、research、inference、workflow 或 model routing/i
  );
});

test('explains zBase as x402 zero-knowledge agent payments, not a generic AI app template', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0xde6e0fe372727db236573bf8b9f32126ea141ba3',
      symbol: 'zBase',
      name: 'zBase'
    },
    market: {
      pairName: 'zBase/WETH',
      websites: [],
      socials: []
    },
    sources: {
      website: {
        url: 'https://zbase.app/',
        title: 'Private payments for AI agents · zBase on Base + Solana',
        markdown:
          "Title: Private payments for AI agents · zBase on Base + Solana\n\nMarkdown Content:\nzBase is a zero-knowledge privacy facilitator for x402 agent payments. Forked from Vitalik Buterin's Privacy Pools, deployed on Base and Solana with on-chain Groth16 verification. ASP-compliant by construction. Base Batches 003 Finalist."
      },
      xProfile: {
        url: 'https://x.com/zbase__',
        displayName: 'zBase',
        handle: '@zbase__',
        bio: 'Privacy is for all, including your agents | @base Batches 003 Finalist',
        followers: 123
      },
      bankr: {
        url: 'https://bankr.bot/launches/0xde6e0fe372727db236573bf8b9f32126ea141ba3',
        tokenName: 'zBase',
        tokenSymbol: 'zBase',
        feeRecipientHandle: '@zbase__',
        feeRecipientWallet: '0x7018a26d05b9be6b8d33abb9efc09bf38c7249cf',
        websiteUrl: 'https://zbase.app/'
      }
    }
  });

  assert.equal(profile.narrative.label, 'ZK Agent支付隐私');
  assert.match(profile.narrative.details[0].value, /x402|zero-knowledge|Privacy Pools|Groth16|private payments|agent payments/i);
  assert.match(profile.narrative.details[1].value, /Base Batches 003 Finalist|@zbase__/i);
  assert.doesNotMatch(
    profile.narrative.origin,
    /AI 应用\/agent 工作流|agent、automation、research、inference、workflow 或 model routing/i
  );
});

test('keeps Mushrooms as a thin dev-backed agent meme when product evidence is missing', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x05972b0b59bb387e94e51a3e6ea7ec87b48b8ba3',
      symbol: 'Mushrooms',
      name: 'Mushrooms Agent'
    },
    market: {
      pairName: 'Mushrooms/WETH',
      websites: [],
      socials: []
    },
    sources: {
      gecko: {
        categories: ['Ai Agents'],
        categoryIds: ['ai-agents'],
        holderCount: 120,
        top10HolderPercentage: 38.5
      },
      xProfile: {
        url: 'https://x.com/DrEthanCaldwell',
        displayName: 'Dr. Ethan Caldwell',
        handle: '@DrEthanCaldwell',
        bio: 'Associate Professor @nyuniversity\nCrypto &amp; Security Group\nCourant Institute, NYU',
        followers: 8856,
        joined: '2026-03-31T13:37:30.000Z',
        markdown: `Title: Dr. Ethan Caldwell (@DrEthanCaldwell) / X
URL Source: http://x.com/DrEthanCaldwell
Published Time: Mon, 25 May 2026 14:50:00 GMT
Markdown Content:
Associate Professor @nyuniversity Crypto &amp; Security Group Courant Institute, NYU`
      },
      bankr: {
        url: 'https://bankr.bot/launches/0x05972b0b59bb387e94e51a3e6ea7ec87b48b8ba3',
        tokenName: 'Mushrooms Agent',
        tokenSymbol: 'Mushrooms',
        feeRecipientHandle: '@DrEthanCaldwell',
        feeRecipientWallet: '0x7b4008fa18d19133022884846d5a36d8a6497eb8',
        feeRecipientUrl: 'https://x.com/DrEthanCaldwell',
        deployerHandle: '@pe___lu'
      }
    }
  });

  assert.equal(profile.narrative.label, 'AI Agent人物meme');
  assert.equal(profile.narrative.category, 'Meme');
  assert.match(profile.narrative.details[0].value, /Mushrooms Agent|@DrEthanCaldwell|NYU|Crypto & Security|人物|agent/i);
  assert.doesNotMatch(profile.narrative.origin, /&amp;|Crypto & Security Group Courant Institute, NYU Associate Professor/i);
  assert.doesNotMatch(profile.narrative.origin, /Title:|URL Source:|Published Time:|Markdown Content:/i);
  assert.match(profile.narrative.details[2].value, /没有抓到官网|没有抓到 Virtuals|未确认|高风险/i);
  assert.match(profile.dev.aiLevel, /不是典型 AI 圈|Crypto & Security|NYU|安全|密码/i);
  assert.doesNotMatch(profile.narrative.origin, /有公开 founder X\/官网产品线索|Virtuals Protocol|Virtuals\/Bonding|产品收入/i);
});

test('explains Recordly as a concrete open-source recording product, not an unresolved meme', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0xf3de9701975ec1e8adae0bb346e059b68322bba3',
      symbol: 'Recordly',
      name: 'Recordly'
    },
    market: {
      websites: [{ url: 'https://recordly.dev/', label: 'Website' }],
      socials: []
    },
    sources: {
      website: {
        url: 'https://recordly.dev/',
        title: 'Recordly - Open-source app for incredible screen recordings.',
        markdown:
          'Recordly is an open-source screen recorder for MacOS/Windows/Linux with auto-zoom, silky cursor animations, beautiful backgrounds, timeline editing, audio capture, MP4/GIF export and .recordly project files. It is a free alternative to Screen Studio for product demos and walkthroughs.'
      },
      xProfile: {
        url: 'https://x.com/webadderall',
        displayName: 'webadderall',
        handle: '@webadderall',
        bio: '16yo indie dev building Recordly (10K+ stars) thinking about product, business, and antifragility',
        followers: 1600
      },
      bankr: {
        url: 'https://bankr.bot/launches/0xf3de9701975ec1e8adae0bb346e059b68322bba3',
        tokenName: 'Recordly',
        tokenSymbol: 'Recordly',
        feeRecipientHandle: '@webadderall',
        feeRecipientWallet: '0x0b3aadf56bc3c0940d326924f8fdc47bc6864a7f',
        websiteUrl: 'https://recordly.dev/'
      }
    }
  });

  assert.equal(profile.narrative.label, '开源录屏工具');
  assert.match(profile.narrative.details[0].value, /screen recorder|录屏|auto-zoom|cursor|timeline|Screen Studio|product demos/i);
  assert.match(profile.dev.aiLevel, /不是典型 AI 圈|录屏|开源产品|未看到/i);
  assert.doesNotMatch(profile.narrative.origin, /没有抓到明确产品锚点|原梗|纯 meme/i);
});

test('explains LIKWID as a DeFi leverage protocol, not a meme or AI app', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x5ae6412562cc34c73e026d9792be53b0cdc33ba3',
      symbol: 'LIKWID',
      name: 'LIKWID'
    },
    market: {
      websites: [{ url: 'https://likwid.fi/', label: 'Website' }],
      socials: []
    },
    sources: {
      website: {
        url: 'https://likwid.fi/',
        title: 'LIKWID',
        markdown:
          'No oracles. No gatekeepers. Just DeFi. Likwid empowers permissionless margin trading and lending for any token. Unified liquidity for Swap, Lending & Margin. Leverage long-tail tokens from day one. LPs earn from swap fees, leverage fees and lending interest. Unifies AMM + Lending into one liquidity pool.'
      },
      xProfile: {
        url: 'https://x.com/likwid_fi',
        displayName: 'LIKWID',
        handle: '@likwid_fi',
        bio: 'Unified Swap · Margin · Lending · Borrow — for any token. Oracle-free. Permissionless. Long-tail leverage. Uniswap | ETHDenver | MVB9',
        followers: 38691
      },
      bankr: {
        url: 'https://bankr.bot/launches/0x5ae6412562cc34c73e026d9792be53b0cdc33ba3',
        tokenName: 'LIKWID',
        tokenSymbol: 'LIKWID',
        feeRecipientHandle: '@likwid_fi',
        websiteUrl: 'https://likwid.fi/'
      }
    }
  });

  assert.equal(profile.narrative.category, 'DeFi');
  assert.equal(profile.narrative.label, 'DeFi杠杆/借贷协议');
  assert.match(profile.narrative.details[0].value, /oracle-free|margin trading|lending|Swap|long-tail|AMM|liquidity/i);
  assert.match(profile.dev.aiLevel, /不是典型 AI 圈|DeFi|未看到/i);
  assert.doesNotMatch(profile.narrative.origin, /AI 应用|没有抓到明确产品锚点|Meme/i);
});

test('explains Printing Press as an AI agent CLI and MCP generator, not Goodheart civic tooling', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x5842cd0c0d50c620c5f00406d7147c6736867ba3',
      symbol: 'PRIN',
      name: 'Printing Press'
    },
    market: {
      websites: [],
      socials: []
    },
    sources: {
      website: {
        url: 'https://github.com/mvanhorn/cli-printing-press',
        title:
          'GitHub - mvanhorn/cli-printing-press: Every API has a secret identity. This finds it, absorbs every feature from every competing tool, then builds the GOAT CLI — designed for AI agents first, with SQLite sync, offline search, and compound insight commands.',
        markdown:
          'Nothing is more valuable than time and money. In a world of AI agents, that is speed and token spend. The Printing Press reads official API docs, studies community CLI and MCP servers, sniffs web APIs, and prints a token-efficient Go CLI plus a Claude Code skill plus an MCP server for any API or website. It uses local SQLite, offline search, compound commands and agent-native flags.'
      },
      xProfile: {
        url: 'https://x.com/trevin',
        displayName: 'Trevin Chow',
        handle: '@trevin',
        bio: 'Exploring, building and obsessing over AI. Ex: @bigcartel @sketchylearning @axontechnology @nike @microsoft',
        followers: 4450
      },
      github: {
        user: {
          login: 'mvanhorn',
          name: null,
          bio: null,
          company: null,
          followers: null,
          publicRepos: null,
          url: 'https://github.com/mvanhorn'
        },
        repos: [
          {
            name: 'cli-printing-press',
            fullName: 'mvanhorn/cli-printing-press',
            description:
              'Every API has a secret identity. Builds the GOAT CLI for AI agents with SQLite sync, offline search, and compound insight commands.',
            stars: null,
            forks: null,
            language: null,
            url: 'https://github.com/mvanhorn/cli-printing-press'
          }
        ],
        topRepoReadme:
          'Prints a token-efficient Go CLI plus a Claude Code skill plus an MCP server for any API or any website.'
      },
      bankr: {
        url: 'https://bankr.bot/launches/0x5842cd0c0d50c620c5f00406d7147c6736867ba3',
        tokenName: 'Printing Press',
        tokenSymbol: 'PRIN',
        feeRecipientHandle: '@trevin',
        deployerHandle: '@hyporliquid',
        websiteUrl: 'https://github.com/mvanhorn/cli-printing-press'
      }
    }
  });

  assert.equal(profile.narrative.label, 'AI Agent CLI生成器');
  assert.match(profile.narrative.details[0].value, /Printing Press|AI agents|CLI|MCP|Claude Code|SQLite|API|website/i);
  assert.match(profile.narrative.details[1].value, /@trevin|mvanhorn\/cli-printing-press|归属|Bankr/i);
  assert.match(profile.dev.aiLevel, /AI agent|CLI|MCP|早期|待确认/i);
  assert.doesNotMatch(JSON.stringify({ narrative: profile.narrative, dev: profile.dev }), /Goodheart|Viewpoints|Community Notes|社区治理|事实核查/i);
});

test('explains Hunch as a prediction-market product, not Goodheart civic tooling', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0xae1f38aee37f5bbeeded6a69b6454f4954b30ba3',
      symbol: 'Hunch',
      name: 'Hunch'
    },
    market: {
      websites: [{ url: 'https://playhunch.xyz/', label: 'Website' }],
      socials: []
    },
    sources: {
      website: {
        url: 'https://playhunch.xyz/',
        title: 'Hunch — Back your hunch',
        markdown:
          'Back your hunch. A social swipe feed for prediction markets. Pick YES or NO with visible odds, then let the agent route, manage, and explain the trade. Best-execution router scans every venue, shows odds, and routes the ticket before settlement. Social signal layer turns Twitter and news context into market-specific momentum. Twitter agent tags @playhunchxyz and returns a one-tap YES/NO market link.'
      },
      xProfile: {
        url: 'https://x.com/rajkaria_',
        displayName: 'Raj Karia',
        handle: '@rajkaria_',
        bio: 'Building',
        followers: 6220
      },
      bankr: {
        url: 'https://bankr.bot/launches/0xae1f38aee37f5bbeeded6a69b6454f4954b30ba3',
        tokenName: 'Hunch',
        tokenSymbol: 'Hunch',
        feeRecipientHandle: '@rajkaria_'
      }
    }
  });

  assert.equal(profile.narrative.label, '预测市场/社交交易');
  assert.match(profile.narrative.details[0].value, /prediction markets|YES|NO|odds|best-execution router|Twitter agent|市场/i);
  assert.doesNotMatch(profile.narrative.origin, /Goodheart|Viewpoints|Community Notes|社区治理|事实核查/i);
});

test('explains Bankr Fund from Bankr agent evidence without inventing a random website', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0xd9e3487e4ec470dbbb85323955ecc00d0733dba3',
      symbol: 'BANKRFUND',
      name: 'Bankr Fund'
    },
    market: {
      websites: [],
      socials: []
    },
    sources: {
      xProfile: {
        url: 'https://x.com/0xDeployer',
        displayName: 'deployer',
        handle: '@0xDeployer',
        bio: 'currently deploying.',
        followers: 47222,
        markdown:
          'just shipped: end-to-end skills demo. install any skill from github, edit in-browser with syntax highlighting, or write one from scratch, your agent executes it. onchain payments included. new demo: bankr terminal deposits Uniswap v3 liquidity, sets up rebalancing automations, creates a reusable skill, creates a PR.'
      },
      bankr: {
        url: 'https://bankr.bot/launches/0xd9e3487e4ec470dbbb85323955ecc00d0733dba3',
        tokenName: 'Bankr Fund',
        tokenSymbol: 'BANKRFUND',
        feeRecipientHandle: '@0xDeployer',
        feeRecipientWallet: '0xce370ebcbc655f845df7dfb8c079e75b5ea17d93'
      }
    }
  });

  assert.equal(profile.narrative.label, 'Bankr生态/agent执行');
  assert.match(profile.narrative.details[0].value, /Bankr|skills demo|agent executes|onchain payments|terminal|Uniswap|automation/i);
  assert.match(profile.narrative.details[2].value, /fund|基金|未确认|风险/i);
  assert.doesNotMatch(profile.narrative.origin, /abs\.twimg|emoji|随机官网/i);
});

test('explains Moat as a GitHub security posture tool, not a code-context tool', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x8112bce2c7d68a8a1d9665feadf2118641d90ba3',
      symbol: 'Moat',
      name: 'Moat'
    },
    market: {
      websites: [],
      socials: []
    },
    sources: {
      website: {
        url: 'https://github.com/laravel/moat',
        title:
          'GitHub - laravel/moat: Moat reviews the security posture of your GitHub organization and repositories, then surfaces recommendations to consider.',
        markdown:
          'Moat reviews the security posture of your GitHub organization and repositories, then surfaces recommendations to consider. It inspects GitHub security controls: 2FA enforcement, branch protection, signed commits, secret scanning, Dependabot alerts, workflow permissions, pinned actions, repository webhooks, and reports which ones are not configured.'
      },
      xProfile: {
        url: 'https://x.com/enunomaduro',
        displayName: 'nunomaduro',
        handle: '@enunomaduro',
        bio: 'staff software engineer at @laravelphp · speaker · content creator · open-source contributor · created @pestphp, pint, pail, larastan, and more.',
        followers: 66075
      },
      github: {
        user: {
          login: 'laravel',
          name: null,
          bio: null,
          company: null,
          followers: null,
          publicRepos: null,
          url: 'https://github.com/laravel'
        },
        repos: [
          {
            name: 'moat',
            fullName: 'laravel/moat',
            description:
              'Moat reviews the security posture of your GitHub organization and repositories, then surfaces recommendations to consider.',
            stars: null,
            forks: null,
            language: null,
            url: 'https://github.com/laravel/moat'
          }
        ],
        topRepoReadme:
          'Moat checks 2FA, branch protection, signed commits, secret scanning, Dependabot alerts, workflow permissions, pinned actions and repository webhooks.'
      },
      bankr: {
        url: 'https://bankr.bot/launches/0x8112bce2c7d68a8a1d9665feadf2118641d90ba3',
        tokenName: 'Moat',
        tokenSymbol: 'Moat',
        feeRecipientHandle: '@enunomaduro',
        websiteUrl: 'https://github.com/laravel/moat'
      }
    }
  });

  assert.equal(profile.narrative.label, 'GitHub安全审计工具');
  assert.match(profile.narrative.details[0].value, /security posture|GitHub organization|2FA|branch protection|secret scanning|Dependabot/i);
  assert.match(profile.dev.aiLevel, /不是典型 AI 圈|Laravel|开源|安全审计/i);
  assert.doesNotMatch(profile.narrative.origin, /RepoPrompt|代码上下文|codemaps|selective context/i);
});

test('explains DMN as an on-chain agent execution project when the project account is available', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x6a0d4a28384b31d708243b99c914e3ee6aae2ba3',
      symbol: 'DMN',
      name: 'Deamon Net'
    },
    market: {
      websites: [],
      socials: []
    },
    sources: {
      xProfile: {
        url: 'https://x.com/bolls',
        displayName: 'bolls',
        handle: '@bolls',
        bio: 'I write exploits, patch them, then write better ones. if code runs, I can break it. working on // @dmn_net',
        followers: 216,
        markdown:
          'I write exploits, patch them, then write better ones. if code runs, I can break it. working on // @dmn_net'
      },
      projectXProfile: {
        url: 'https://x.com/dmn_net',
        displayName: 'Deamon Net',
        handle: '@dmn_net',
        bio: 'Agents that never sleep. 350ms event-to-execution. Live on Base. By @bolls on-chain dmn-net.io',
        followers: 176,
        markdown:
          'Agents that never sleep. 350ms event-to-execution. Live on Base. By @bolls on-chain dmn-net.io'
      },
      bankr: {
        url: 'https://bankr.bot/launches/0x6a0d4a28384b31d708243b99c914e3ee6aae2ba3',
        tokenName: 'Deamon Net',
        tokenSymbol: 'DMN',
        feeRecipientHandle: '@bolls',
        feeRecipientWallet: '0x282ab7e0f1828e9f812537f7e2323350e79a988e'
      }
    }
  });

  assert.equal(profile.narrative.label, '链上agent执行网络');
  assert.match(profile.narrative.details[0].value, /Agents that never sleep|350ms|event-to-execution|Live on Base|exploit/i);
  assert.match(profile.dev.aiLevel, /安全工程|exploit|agent|早期/i);
  assert.doesNotMatch(profile.narrative.origin, /没有抓到明确产品锚点|原梗|Meme/i);
  assert.ok(profile.sourceLinks.includes('https://x.com/dmn_net'));
});

test('filters media assets, markdown filenames and social preview images from source links', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0xd9e3487e4ec470dbbb85323955ecc00d0733dba3',
      symbol: 'BANKRFUND',
      name: 'Bankr Fund'
    },
    market: {
      pairUrl: 'https://dexscreener.com/base/0xd97130e142ef8b4b12b2e5a31e213a6991d98cbbfec8ae819139cdba9d6d01b7',
      websites: [{ url: 'https://SKILL.md', label: 'Website' }],
      socials: []
    },
    sources: {
      website: {
        url: 'https://SKILL.md',
        discoveredLinks: [
          'https://media.recordly.dev/videos/landinghero.mp4',
          'https://www.playhunch.xyz/opengraph-image',
          'https://www.playhunch.xyz/twitter-image',
          'https://playhunch.xyz/docs'
        ]
      },
      bankr: {
        url: 'https://bankr.bot/launches/0xd9e3487e4ec470dbbb85323955ecc00d0733dba3',
        tokenName: 'Bankr Fund',
        tokenSymbol: 'BANKRFUND',
        feeRecipientHandle: '@0xDeployer'
      }
    }
  });

  assert.doesNotMatch(profile.sourceLinks.join('\n'), /skill\.md|landinghero\.mp4|opengraph-image|twitter-image/i);
  assert.ok(profile.sourceLinks.includes('https://bankr.bot/launches/0xd9e3487e4ec470dbbb85323955ecc00d0733dba3'));
});

test('explains Goodheart Labs as a concrete AI civic consensus product, not a generic AI app', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x890b352223baaa2c4bd5ccd5b42e875ca1e75ba3',
      symbol: 'GOOD',
      name: 'Goodheart Labs'
    },
    market: {
      websites: [{ url: 'https://goodheartlabs.com/', label: 'Website' }],
      socials: []
    },
    sources: {
      website: {
        url: 'https://goodheartlabs.com/',
        title: 'Goodheart Labs',
        markdown: `
Title: Goodheart Labs

URL Source: https://goodheartlabs.com/

Markdown Content:
### Viewpoints

production

A community mediation tool that enables rapid consensus building through AI-powered polling. Create polls in minutes, gather insights instantly, and understand where your community stands on important issues.

#### Key Capabilities

*   AI-powered poll creation
*   2-minute setup time
*   QR code sharing
*   Anonymous responses
*   Real-time results
*   Statement-based polling
*   Tinder-style swipe responses
*   4-tier response system (agree/disagree/don't know/badly framed)

### Finding Consensus

production

A platform for visualizing and exploring expert perspectives on critical AI policy questions, focusing on legislation like SB-1047 and its implications for AI development.

### Is This True?

beta

An AI-powered browser extension that makes fact-checking as simple as right-clicking. Get instant context and verification for any statement you encounter online.

### When Will We Get AGI? | AGI Timeline

prototype

Crowd-sourced dashboard forecasting when Artificial General Intelligence (AGI) will arrive. Aggregates predictions from Metaculus, Manifold, Kalshi, and more to provide the best consensus on AGI timelines.
        `
      },
      xProfile: {
        url: 'https://x.com/NathanpmYoung',
        displayName: 'Nathan is in.. Rhode Island?? 🔎',
        handle: '@NathanpmYoung',
        bio: 'Director, Goodheart Labs. AI-written Community Notes (world first). Part time forecaster @swift_centre. Capital case tweets are literal, others less.',
        followers: 29954,
        joined: '2013-02-08T19:13:45.000Z',
        markdown:
          'AI Note-writer Progress Our note-writer has written community notes on X with 47M views. The cost per helpful note is about $7.'
      },
      bankr: {
        url: 'https://bankr.bot/launches/0x890b352223baaa2c4bd5ccd5b42e875ca1e75ba3',
        tokenName: 'Goodheart Labs',
        tokenSymbol: 'GOOD',
        chain: 'base',
        feeRecipientWallet: '0xd974d96b8843fc02b44320d82412801201cccaf0',
        feeRecipientHandle: '@NathanpmYoung',
        feeRecipientUrl: 'https://x.com/NathanpmYoung',
        deployerWallet: '0x0c7e483f60163cbd9aa24e85a7ab9cd9fe1b82e0',
        deployerHandle: '@hyporliquid',
        tweetUrl: 'https://x.com/NathanpmYoung/status/2057284454159442144',
        websiteUrl: 'https://goodheartlabs.com/'
      }
    }
  });

  assert.equal(profile.narrative.label, 'AI社区治理/共识工具');
  assert.match(profile.narrative.thesis, /Goodheart Labs|社区治理|共识|AI-powered polling|Viewpoints/i);
  assert.match(profile.narrative.details[0].value, /Viewpoints|community mediation|AI-powered polling|Finding Consensus|Is This True|Community Notes/i);
  assert.match(profile.narrative.details[0].value, /不是泛泛的 agent|共识形成|事实核查|预测市场/i);
  assert.doesNotMatch(profile.narrative.details[0].value, /agent、automation、research、inference、workflow 或 model routing/i);
  assert.match(profile.dev.aiLevel, /二线偏强|AI 社区治理|事实核查|预测|Goodheart Labs|3万粉|Community Notes/i);
  assert.doesNotMatch(profile.dev.aiLevel, /Staff Eng|MCP|codemaps/i);
  assert.match(profile.dev.cryptoLevel, /三线|早期|Bankr|Fee Recipient|币圈原生/i);
});

test('explains PSVIEW as a Virtuals AI Agent narrative with fee-delegated dev evidence', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0xb2a99bc73c89b6bcbeb4650eedcd5f2776373c48',
      symbol: 'PSVIEW',
      name: 'PSVIEW'
    },
    market: {
      priceUsd: 0.00088,
      marketCapUsd: 880000,
      liquidityUsd: 120000,
      volume24h: 724240.28,
      pairUrl: 'https://dexscreener.com/base/0xb7cd695a77994afe94ecbaee85b0eab5e0aa43fd',
      quoteTokenSymbol: 'VIRTUAL',
      quoteTokenName: 'Virtual Protocol',
      websites: [],
      socials: []
    },
    sources: {
      gecko: {
        url: 'https://api.geckoterminal.com/api/v2/networks/base/tokens/0xb2a99bc73c89b6bcbeb4650eedcd5f2776373c48/info',
        tokenAddress: '0xb2a99bc73c89b6bcbeb4650eedcd5f2776373c48',
        description: 'PSVIEW token',
        websites: ['https://app.virtuals.io/virtuals/77450'],
        categories: ['Virtuals Protocol', 'Ai Agents'],
        categoryIds: ['virtuals-protocol', 'ai-agents'],
        holderCount: 446,
        top10HolderPercentage: 49.226,
        isHoneypot: false
      },
      virtuals: {
        url: 'https://app.virtuals.io/virtuals/77450',
        apiUrl: 'https://api2.virtuals.io/api/virtuals/77450?populate=genesis,vibesInfo,launchInfo',
        id: 77450,
        name: 'PSVIEW',
        symbol: 'PSVIEW',
        description: 'PSVIEW token',
        category: 'IP MIRROR',
        tokenAddress: '0xb2a99bc73c89b6bcbeb4650eedcd5f2776373c48',
        lpAddress: '0xb7Cd695a77994aFe94EcBAee85B0EAb5e0Aa43fD',
        holderCount: 446,
        volume24h: 724240.28,
        priceChangePercent24h: 21.86,
        factory: 'BONDING_V5',
        launchedAt: '2026-05-23T09:34:41.000Z',
        isDevCommitted: false,
        feeDelegationType: 'twitter',
        feeDelegatedRecipient: 'MikaelSourati',
        feeDelegationClaimed: true,
        feeDelegationVaultAddress: '0xC6F6F0Ba2C40d313C58b16BaB7131408BD7EED75',
        taxRecipient: '0x65e2F5E14Cc8d294fc2ADD3e9108377a1259cB59',
        creatorTwitterUrl: 'https://x.com/MikaelSourati',
        creatorTwitterHandle: '@MikaelSourati'
      },
      xProfile: {
        url: 'https://x.com/MikaelSourati',
        displayName: 'Mikael Sourati',
        handle: '@MikaelSourati',
        bio: 'Building the future of recruiting | Founder @ Psview | 70K ARR in 3 months | 21 yo |',
        followers: 443,
        markdown:
          'Building the future of recruiting | Founder @ Psview | 70K ARR in 3 months | 21 yo | psview.ai PSVIEW is the onchain story of Luke. YC rejected, community believed.'
      },
      website: {
        url: 'https://psview.ai/',
        title: 'Psview',
        markdown:
          'Staffing Reinvented. AI that finds and places the best talent for you. The best staffing firms use PsView for Intelligent Sourcing, Automated Matching, Talent Pool Management, Candidate Proposals, Predictive Analytics, Market Intelligence, Talent Pool Refresh and Performance Tracking. Increase in placement volume +30%. Faster candidate submittal 10x. Reduction in bench time -20%.'
      }
    }
  });

  assert.equal(profile.narrative.category, 'AI');
  assert.equal(profile.narrative.label, 'Virtuals AI Agent');
  assert.match(profile.narrative.thesis, /Base 链上 Virtuals Protocol.*AI Agent.*\$PSVIEW/i);
  assert.match(profile.narrative.details[0].value, /Virtuals Protocol|AI Agent|IP Mirror|PSVIEW\/VIRTUAL|Luke|YC|招聘|sourcing|matching|社区/i);
  assert.match(profile.narrative.details[1].value, /@MikaelSourati|feeDelegationType=twitter|feeDelegationClaimed=true|creator verified Twitter|holder/i);
  assert.match(profile.narrative.details[2].value, /dev committed=false|top10|49|早期|轮动|高风险/i);
  assert.equal(profile.dev.publicHandle, '@MikaelSourati');
  assert.equal(profile.dev.identityStatus, 'Virtuals Fee Delegation确认');
  assert.match(profile.dev.who, /Virtuals.*fee delegation.*@MikaelSourati|收益接收方/i);
  assert.match(profile.dev.aiLevel, /早期|Virtuals AI Agent|AI 背景|招聘|70K ARR|产品/i);
  assert.match(profile.dev.cryptoLevel, /Virtuals|Base|fee delegation|新盘|早期/i);
  assert.match(profile.evidence.join('\n'), /GeckoTerminal.*Virtuals Protocol.*Ai Agents|Virtuals.*77450|feeDelegationClaimed=true|PSVIEW\/VIRTUAL/i);
  assert.ok(profile.sourceLinks.includes('https://app.virtuals.io/virtuals/77450'));
  assert.ok(profile.sourceLinks.includes('https://x.com/MikaelSourati'));
});

test('explains ORION from Virtuals official links and founder team without Bankr wording', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x96de193c2f6fe14d931eaada5abd6fb372a8d2a5',
      symbol: 'ORION',
      name: 'OrionX Robotics'
    },
    market: {
      pairName: 'ORION/VIRTUAL',
      pairUrl: 'https://dexscreener.com/base/0xa115ba0e2a1055eca844b4b1ed049f3938c2158c',
      quoteTokenSymbol: 'VIRTUAL',
      quoteTokenName: 'Virtual Protocol',
      websites: [],
      socials: []
    },
    sources: {
      gecko: {
        url: 'https://api.geckoterminal.com/api/v2/networks/base/tokens/0x96de193c2f6fe14d931eaada5abd6fb372a8d2a5/info',
        tokenAddress: '0x96de193c2f6fe14d931eaada5abd6fb372a8d2a5',
        websites: ['https://app.virtuals.io/virtuals/76475'],
        categories: ['Virtuals Protocol', 'Ai Agents'],
        categoryIds: ['virtuals-protocol', 'ai-agents'],
        holderCount: 32,
        top10HolderPercentage: 100,
        gtVerified: false
      },
      virtuals: {
        url: 'https://app.virtuals.io/virtuals/76475',
        apiUrl: 'https://api2.virtuals.io/api/virtuals/76475?populate=genesis,vibesInfo,launchInfo,creator,image,tags,framework,projectMembers',
        id: 76475,
        name: 'OrionX Robotics',
        symbol: 'ORION',
        description: 'Physical AI robotics agent',
        overview: 'ARES is a Vision-Language-Action brain for humanoid robots in battlefield and hazardous sites.',
        category: 'IP MIRROR',
        tokenAddress: '0x96de193c2f6fe14d931eaada5abd6fb372a8d2a5',
        virtualsWalletAddress: '0x9ba60e0acb75a730b9830fa74836e800e47a1580',
        holderCount: 32,
        top10HolderPercentage: 100,
        isVerified: false,
        isDevCommitted: false,
        factory: 'BONDING_V5',
        feeDelegationType: null,
        feeDelegatedRecipient: null,
        feeDelegationClaimed: false,
        feeDelegationVaultAddress: null,
        taxRecipient: null,
        creatorTwitterUrl: 'https://x.com/VictorRowanAi',
        creatorTwitterHandle: '@VictorRowanAi',
        projectTwitterUrl: 'https://x.com/OrionX_Robotics',
        projectTwitterHandle: '@OrionX_Robotics',
        projectWebsiteUrl: 'https://orionxrobotics.xyz/',
        videoPitchTweetUrl: 'https://x.com/OrionX_Robotics/status/2055173430476234977',
        tokenUtility:
          'Revenue Share, Buyback & Burn, Stake-to-Use, Hardware Bridge, Intel Feed and Governance.',
        roadmap: 'Phase 1 — Foundation & Public Launch. ARES v0.2, Unitree G1 EDU and Isaac Sim.',
        additionalDetails:
          'OrionX builds the brain for humanoid robots in defense, nuclear, industrial, data center and other hazardous sites. ARES is the Autonomous Reasoning and Execution System. The pitch is Anduril of the humanoid age.',
        projectMembers: [
          {
            title: 'Co-Founder & CEO',
            displayName: 'Victor Rowan',
            twitterUrl: 'https://x.com/VictorRowanAi',
            twitterHandle: '@VictorRowanAi',
            bio:
              'Victor Rowan\nCo-Founder & CEO · Defense Partnerships & GTM\n\nB.Tech Electronics. Ex-Neurolov AI infrastructure at $13M+ government contract scale via Adani Defence.'
          },
          {
            title: 'Adhik Joshi (Co-Founder & CTO))',
            displayName: 'Adhik Joshi',
            telegramUrl: 'https://t.me/rebond97',
            telegramHandle: '@rebond97',
            githubUrl: 'https://github.com/adhikjoshi',
            githubUsername: 'adhikjoshi',
            bio:
              'Co-Founder & CTO · ARES VLA System & Robotics\n\nB.Tech Computer Science. AI Systems Architect across NVIDIA GR00T, OpenVLA, Physical Intelligence pi-zero, Helix-level VLA architectures, Isaac Sim battlefield simulation and ROS 2 deployment runtime on Unitree G1 EDU.'
          }
        ]
      }
    }
  });

  assert.equal(profile.narrative.category, 'AI');
  assert.equal(profile.narrative.label, 'Virtuals AI Agent');
  assert.match(profile.narrative.details[0].value, /Physical AI|humanoid|ARES|Vision-Language-Action|VLA|defense|hazardous|Unitree|Isaac Sim|Anduril/i);
  assert.match(profile.narrative.details[1].value, /@OrionX_Robotics|orionxrobotics\.xyz|video pitch|@VictorRowanAi|Adhik Joshi|adhikjoshi/i);
  assert.doesNotMatch(profile.narrative.details[1].value, /feeDelegatedRecipient=@VictorRowanAi/);
  assert.match(profile.narrative.details[2].value, /fee delegation.*未确认|dev committed=false|top10.*100|verified=false|高风险/i);
  assert.equal(profile.dev.publicHandle, '@VictorRowanAi');
  assert.equal(profile.dev.identityStatus, 'Virtuals Team确认');
  assert.equal(profile.dev.feeRecipientWallet, null);
  assert.equal(profile.dev.virtualsWalletAddress, '0x9ba60e0acb75a730b9830fa74836e800e47a1580');
  assert.match(profile.dev.who, /Virtuals projectMembers|Victor Rowan|@VictorRowanAi|Adhik Joshi|没有 fee delegation/i);
  assert.match(profile.dev.background, /Co-Founder & CEO|Co-Founder & CTO|Defense Partnerships|ARES VLA|GitHub adhikjoshi/i);
  assert.match(profile.dev.aiLevel, /Physical AI|机器人|humanoid|防务|ARES|VLA|Unitree|Isaac Sim|中上|早期偏强/i);
  assert.match(profile.dev.cryptoLevel, /Virtuals\/Base|项目团队|未看到 fee delegation|早期|tokenomics|walletAddress/i);
  assert.doesNotMatch(JSON.stringify(profile.dev), /Bankr fee recipient|Bankr Fee Recipient|Bankr launch/);
  assert.ok(profile.sourceLinks.includes('https://app.virtuals.io/virtuals/76475'));
  assert.ok(profile.sourceLinks.includes('https://x.com/OrionX_Robotics'));
  assert.ok(profile.sourceLinks.includes('https://orionxrobotics.xyz'));
  assert.ok(profile.sourceLinks.includes('https://x.com/OrionX_Robotics/status/2055173430476234977'));
  assert.ok(profile.sourceLinks.includes('https://x.com/VictorRowanAi'));
  assert.ok(profile.sourceLinks.includes('https://github.com/adhikjoshi'));
});

test('explains a Virtuals prototype token with delegate-to dev evidence', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x8cb8bd0fee144ca6dd4f2a98374b0a0c90810401',
      symbol: 'LITEFOLD',
      name: 'LITEFOLD'
    },
    market: {
      priceUsd: 0.00021096,
      marketCapUsd: 211700,
      liquidityUsd: 64790,
      volume24h: 215990,
      pairName: 'LITEFOLD/USDC',
      pairUrl: 'https://dexscreener.com/base/0x65a08364602fdd738ec0dda25b26d6fb586a33e305b927f5c3f3b113002daf04',
      websites: [],
      socials: []
    },
    sources: {
      virtuals: {
        url: 'https://app.virtuals.io/prototypes/0x8cb8bd0fee144ca6dd4f2a98374b0a0c90810401',
        prototypeAddress: '0x8cb8bd0fee144ca6dd4f2a98374b0a0c90810401',
        tokenAddress: '0x8cb8bd0fee144ca6dd4f2a98374b0a0c90810401',
        name: 'LITEFOLD',
        symbol: 'LITEFOLD',
        category: 'PROTOTYPE',
        feeDelegationType: 'twitter',
        feeDelegatedRecipient: 'anindyadeeps',
        feeDelegationClaimed: null,
        creatorTwitterUrl: 'https://x.com/anindyadeeps',
        creatorTwitterHandle: '@anindyadeeps'
      },
      xProfile: {
        url: 'https://x.com/anindyadeeps',
        displayName: 'Anindya',
        handle: '@anindyadeeps',
        bio: 'Building AI agents and onchain products.',
        followers: 1200,
        markdown: 'Building AI agents and onchain products.'
      }
    }
  });

  assert.equal(profile.narrative.category, 'AI');
  assert.equal(profile.narrative.label, 'Virtuals AI Agent');
  assert.match(profile.narrative.thesis, /Base 链上 Virtuals Protocol.*\$LITEFOLD/i);
  assert.match(profile.narrative.details[0].value, /Virtuals Protocol|prototype|LITEFOLD|Delegate to|@anindyadeeps/i);
  assert.match(profile.narrative.details[1].value, /@anindyadeeps|feeDelegationType=twitter|prototype 页面/i);
  assert.equal(profile.dev.publicHandle, '@anindyadeeps');
  assert.equal(profile.dev.feeRecipientHandle, '@anindyadeeps');
  assert.equal(profile.dev.identityStatus, 'Virtuals Fee Delegation确认');
  assert.match(profile.dev.who, /Virtuals prototype 页面.*@anindyadeeps|收益接收方/i);
  assert.match(profile.dev.cryptoLevel, /Virtuals|Base|fee delegation|新盘|早期/i);
  assert.match(profile.evidence.join('\n'), /Virtuals prototype|anindyadeeps|LITEFOLD\/USDC/i);
  assert.ok(
    profile.sourceLinks.includes('https://app.virtuals.io/prototypes/0x8cb8bd0fee144ca6dd4f2a98374b0a0c90810401')
  );
  assert.ok(profile.sourceLinks.includes('https://x.com/anindyadeeps'));
});

test('explains LazyCodex as an OmO/Codex lazy coding tool, not an empty meme', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0x9175e6be4ca255ffb0b5f57454156514ce9e1ba3',
      symbol: 'LAZYCODEX',
      name: 'Lazy Codex'
    },
    market: {
      priceUsd: 0.0000004888,
      marketCapUsd: 48888,
      liquidityUsd: 43305.49,
      volume24h: 87515.89,
      websites: [{ url: 'https://lazycodex.ai/', label: 'Website' }],
      socials: []
    },
    sources: {
      website: {
        url: 'https://lazycodex.ai/',
        title: 'LazyCodex — Codex for lazy people. Coming June 2026.',
        markdown:
          "LazyCodex — Codex for lazy people. Coming June 2026. OmO in Codex. Currently on OpenCode. CODEX FOR NO-BRAINERS. You don't need to think. Just prompt with ultrawork."
      },
      xProfile: {
        url: 'https://x.com/q_yeon_gyu_kim',
        displayName: 'Q',
        handle: '@q_yeon_gyu_kim',
        bio: 'Building oh-my-opencode. 23y/o hacker.',
        followers: 3084,
        markdown:
          'hi guys omo in codex soon lazycodex.ai but basically still it is just omo the tool for token lovers, token burners, token maxxxers stay tuned. unrelated profile text mentions OSS Agent Meta-Harness, agent harness, skills, instincts, memory, security, MCP, codemaps for Claude Code, Codex, OpenCode and Cursor.'
      },
      github: {
        user: {
          login: 'code-yeongyu',
          name: 'YeonGyu-Kim',
          bio: 'Building oh-my-opencode',
          company: null,
          followers: 110,
          publicRepos: 18,
          url: 'https://github.com/code-yeongyu'
        },
        repos: [
          {
            name: 'oh-my-openagent',
            fullName: 'code-yeongyu/oh-my-openagent',
            description:
              'OpenCode and Codex workflow experiments with Claude Code style telemetry, guardrails and experimental features.',
            stars: 59380,
            forks: 4840,
            language: 'TypeScript',
            url: 'https://github.com/code-yeongyu/oh-my-openagent'
          }
        ],
        topRepoReadme:
          'OmO in Codex soon. Currently on OpenCode. Codex for lazy people, prompt with ultrawork.'
      },
      bankr: {
        url: 'https://bankr.bot/launches/0x9175e6be4ca255ffb0b5f57454156514ce9e1ba3',
        tokenName: 'Lazy Codex',
        tokenSymbol: 'LAZYCODEX',
        feeRecipientHandle: '@q_yeon_gyu_kim',
        feeRecipientWallet: '0x4fb24b9ac708197d1654648d76b8eda90e329df6',
        tweetUrl: 'https://x.com/q_yeon_gyu_kim/status/2058921658342355013',
        websiteUrl: 'https://lazycodex.ai/'
      }
    }
  });

  assert.equal(profile.narrative.category, 'AI');
  assert.equal(profile.narrative.label, 'AI Coding懒人工具');
  assert.match(profile.narrative.thesis, /LazyCodex|Codex|lazy|OmO/i);
  assert.match(profile.narrative.details[0].value, /Codex for lazy people|OmO in Codex|OpenCode|ultrawork|no-brainers/i);
  assert.match(profile.narrative.details[1].value, /@q_yeon_gyu_kim|oh-my-opencode|token lovers|Bankr Fee Recipient/i);
  assert.match(profile.narrative.details[2].value, /Coming June 2026|早期|demo|token utility|未确认/i);
  assert.match(profile.dev.aiLevel, /oh-my-opencode|OpenCode|coding agent|早期|builder/i);
  assert.match(profile.dev.cryptoLevel, /Bankr Fee Recipient|token lovers|Base|早期/i);
  assert.doesNotMatch(JSON.stringify({ narrative: profile.narrative, dev: profile.dev }), /ECC Tools|Meta-Harness 的 creator|free-code|Gladium|Paolo/i);
  assert.doesNotMatch(profile.narrative.origin, /没有抓到明确产品锚点|更像名字、图标|Meme/i);
});

test('explains BlindCache as Nillion encrypted AI memory, not Hunch prediction market', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0xebfa52204be13672bc021102ad723e457b47cba3',
      symbol: 'blindcache',
      name: 'BlindCache'
    },
    market: {
      priceUsd: 0.000001959,
      marketCapUsd: 195951,
      liquidityUsd: 114515.17,
      volume24h: 1042126.58,
      websites: [{ url: 'https://github.com/nikshepsvn/blindcache', label: 'Website' }],
      socials: []
    },
    sources: {
      website: {
        url: 'https://github.com/nikshepsvn/blindcache',
        title: 'GitHub - nikshepsvn/blindcache',
        markdown:
          "An encrypted memory layer for AI agents, built on Nillion's Blind Computer. MCP server + vault SDK that no operator — not even us — can read. Content is split into Shamir-style shares across three nilDB nodes. SDK only recombines on your machine. Works with Claude Code, Cursor, Venice, any MCP-compatible AI. Private auto-tag + summarize via nilAI."
      },
      xProfile: {
        url: 'https://x.com/nikshepsvn',
        displayName: 'nik',
        handle: '@nikshepsvn',
        bio: 'prev tech-lead Instacart ads, data/infra at Coinbase, PagerDuty, SeatGeek, CS @ Waterloo. I also follow prediction markets.',
        followers: 7938,
        markdown:
          'Venice gives you private inference. but if you want private memory... today i am releasing blindcache. encrypted, portable, fast memory for any mcp-compatible ai built using Nillion stack data is sharded and encrypted across 3/4-node blind computer testnet is free, production requires $NIL no operator can decrypt your content — not even me works with claude code, venice, cursor, any mcp client apache 2.0. profile also mentions ECC, OSS Agent Meta-Harness, agent harness, Codex, OpenCode, skills, instincts, security and codemaps.'
      },
      github: {
        user: {
          login: 'nikshepsvn',
          name: 'Nik',
          bio: 'building encrypted memory for AI agents',
          company: 'prev Coinbase / Instacart',
          followers: 312,
          publicRepos: 42,
          url: 'https://github.com/nikshepsvn'
        },
        repos: [
          {
            name: 'blindcache',
            fullName: 'nikshepsvn/blindcache',
            description:
              "Encrypted memory layer for AI agents, built on Nillion's Blind Computer. MCP server + vault SDK that no operator can read.",
            stars: 114,
            forks: 12,
            language: 'TypeScript',
            url: 'https://github.com/nikshepsvn/blindcache'
          }
        ],
        topRepoReadme:
          'BlindCache is the same shape as Mem0, Letta, Zep and ChatGPT memory, but the substrate is Nillion Blind Computer. It uses nilDB, Blindfold, NUC tokens and nilAI.'
      },
      bankr: {
        url: 'https://bankr.bot/launches/0xebfa52204be13672bc021102ad723e457b47cba3',
        tokenName: 'BlindCache',
        tokenSymbol: 'blindcache',
        feeRecipientHandle: '@nikshepsvn',
        feeRecipientWallet: '0xb111d2da707ee7bddc14fe48f76a536b090298f3',
        deployerHandle: '@eeunqbla',
        tweetUrl: 'https://x.com/nikshepsvn/status/2057863073613099418',
        websiteUrl: 'https://github.com/nikshepsvn/blindcache'
      }
    }
  });

  assert.equal(profile.narrative.category, 'AI');
  assert.equal(profile.narrative.label, '加密AI记忆层');
  assert.match(profile.narrative.thesis, /BlindCache|Nillion|memory/i);
  assert.match(profile.narrative.details[0].value, /encrypted memory layer|Nillion|Blind Computer|MCP|vault SDK|Claude Code|Cursor|Venice/i);
  assert.match(profile.narrative.details[1].value, /@nikshepsvn|Coinbase|Instacart|GitHub|Bankr Fee Recipient/i);
  assert.match(profile.narrative.details[2].value, /Mem0|Letta|Zep|ChatGPT memory|\$NIL|安全|token/i);
  assert.match(profile.dev.aiLevel, /AI infra|加密记忆|Nillion|MCP|Claude Code|Cursor|技术/i);
  assert.match(profile.dev.cryptoLevel, /Coinbase|Nillion|\$NIL|Bankr Fee Recipient|早期/i);
  assert.doesNotMatch(JSON.stringify({ narrative: profile.narrative, dev: profile.dev }), /Hunch|playhunch|YES\/NO|social swipe feed|best-execution router/i);
});

test('keeps meme origin unresolved when no source evidence exists', () => {
  const profile = buildCoinProfile({
    row: {
      address: '0xdead',
      symbol: 'MOONCAT',
      name: 'Moon Cat'
    },
    market: {
      priceUsd: 0.000001,
      marketCapUsd: 220000,
      liquidityUsd: 9000,
      volume24h: 4000,
      websites: [],
      socials: []
    },
    sources: {}
  });

  assert.equal(profile.narrative.category, 'Meme');
  assert.match(profile.narrative.origin, /梗|来源|传播|未确认|没找到/i);
  assert.deepEqual(
    profile.narrative.details.map((item) => item.label),
    ['叙事核心（社区主推版本）', 'Dev 背书 + 社区期待', '风险/未确认']
  );
  assert.match(profile.narrative.details.map((item) => item.value).join('\n'), /Moon Cat|原梗|人物|传播源头|未确认/i);
  assert.equal(profile.dev.identityStatus, '未确认');
});
