export const DOCUMENT = 'complimentary_licence';

export const VERSION = '2026-09-05';

export const TITLE = 'BotApprove complimentary licence';

export const INTRO =
  'This key was issued free of charge. Redeeming it means accepting the terms below. ' +
  'Anything not covered here is governed by the Terms of Service.';

export const SECTIONS = [
  {
    heading: 'What you get',
    body: 'Premium features on this server, at no cost, with no expiry date.',
  },
  {
    heading: 'What it is not',
    body: 'A gift, not a sale. Nothing is paid, so nothing is owed: no warranty, no uptime '
      + 'commitment, no support obligation, and no refund, because there is no payment to refund.',
  },
  {
    heading: 'One server, and yours alone',
    body: 'The key binds to the first server that redeems it and does not move afterwards. You may '
      + 'not sell it, trade it, give it away, post it publicly, or share it outside your own '
      + "server's staff.",
  },
  {
    heading: 'It can be revoked at any time',
    body: 'The operator may revoke a complimentary licence at any time, at their sole discretion, '
      + 'with or without notice.',
    list: [
      'Misusing BotApprove or any of its features',
      'Using it to harass, deceive, or cause harm to anyone',
      'Submitting false or malicious entries to the shared threat list',
      'Sharing, selling, or publishing the key',
      'Attempting to bypass entitlement checks, tamper with the bot, or interfere with the service',
      'Breaching the Terms of Service',
      'The promotional programme ending, which may happen at any time',
    ],
    after: 'No reason has to be given, and revoking one key does not affect any other.',
  },
  {
    heading: 'What revocation actually means',
    body: 'Premium features switch off. Your server keeps working: the approval gate, keyword '
      + 'blocking, audit trail and tamper detection are free forever and do not depend on this '
      + 'licence. Your settings, whitelist and keyword list are kept. The bot does not leave your '
      + 'server because a complimentary licence ended.',
  },
];
