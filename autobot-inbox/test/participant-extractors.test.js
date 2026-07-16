import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAddressHeader,
  splitAddressList,
  extractFromTldvSegments,
  extractFromEmailThread,
  extractFromEmailParticipantStrings,
  extractFromDriveFile,
  extractParticipants,
} from '../../lib/rag/participants/extractors.js';

describe('participants/extractors', () => {
  describe('parseAddressHeader', () => {
    it('parses quoted name + angle-bracket email', () => {
      assert.deepEqual(parseAddressHeader('"Eric Gang" <eric@staqs.io>'), {
        name: 'Eric Gang',
        email: 'eric@staqs.io',
      });
    });

    it('parses unquoted name + angle-bracket email', () => {
      assert.deepEqual(parseAddressHeader('Eric Gang <eric@staqs.io>'), {
        name: 'Eric Gang',
        email: 'eric@staqs.io',
      });
    });

    it('parses bare email', () => {
      assert.deepEqual(parseAddressHeader('eric@staqs.io'), { email: 'eric@staqs.io' });
    });

    it('lowercases emails', () => {
      assert.equal(parseAddressHeader('ERIC@Staqs.IO').email, 'eric@staqs.io');
    });

    it('returns name-only for strings with no email', () => {
      assert.deepEqual(parseAddressHeader('John Smith'), { name: 'John Smith' });
    });

    it('returns null for empty input', () => {
      assert.equal(parseAddressHeader(''), null);
      assert.equal(parseAddressHeader(null), null);
    });
  });

  describe('splitAddressList', () => {
    it('splits on comma', () => {
      assert.deepEqual(
        splitAddressList('a@x.com.com, b@y.com, c@z.com'),
        ['a@x.com.com', 'b@y.com', 'c@z.com']
      );
    });

    it('preserves commas inside quoted names', () => {
      assert.deepEqual(
        splitAddressList('"Smith, John" <john@x>, jane@y'),
        ['"Smith, John" <john@x>', 'jane@y']
      );
    });

    it('returns empty for empty input', () => {
      assert.deepEqual(splitAddressList(''), []);
      assert.deepEqual(splitAddressList(null), []);
    });
  });

  describe('extractFromTldvSegments', () => {
    it('deduplicates speakers and counts turns', () => {
      const segs = [
        { content: 'hello', metadata: { speaker: 'John Doe' } },
        { content: 'world', metadata: { speaker: 'Jane Smith' } },
        { content: 'again', metadata: { speaker: 'John Doe' } },
      ];
      const out = extractFromTldvSegments(segs);
      assert.equal(out.length, 2);
      const john = out.find(p => p.name === 'John Doe');
      assert.equal(john.turns, 2);
      assert.equal(john.role, 'speaker');
    });

    it('ignores segments without speaker', () => {
      assert.deepEqual(extractFromTldvSegments([{ content: 'x' }]), []);
    });
  });

  describe('extractFromEmailThread', () => {
    it('collects from/to/cc across messages with role ranking', () => {
      const messages = [
        { headers: { from: 'A <a@x.com>', to: 'B <b@x.com>, C <c@x.com>', cc: 'D <d@x.com>' } },
        { headers: { from: 'B <b@x.com>', to: 'A <a@x.com>', cc: 'D <d@x.com>' } },
      ];
      const out = extractFromEmailThread(messages);
      const byEmail = Object.fromEntries(out.map(p => [p.email, p]));
      assert.equal(byEmail['a@x.com'].role, 'sender');     // promoted from recipient
      assert.equal(byEmail['b@x.com'].role, 'sender');     // was recipient, later sender
      assert.equal(byEmail['c@x.com'].role, 'recipient');
      assert.equal(byEmail['d@x.com'].role, 'cc');
    });
  });

  describe('extractFromEmailParticipantStrings', () => {
    it('parses backfill-shape strings and dedupes by email', () => {
      const out = extractFromEmailParticipantStrings([
        '"Eric" <eric@staqs.io>',
        'ERIC@staqs.io', // duplicate
        'jane@example.com',
      ]);
      assert.equal(out.length, 2);
      const emails = out.map(p => p.email).sort();
      assert.deepEqual(emails, ['eric@staqs.io', 'jane@example.com']);
    });
  });

  describe('extractFromDriveFile', () => {
    it('pulls owners and lastModifyingUser with correct roles', () => {
      const file = {
        owners: [{ emailAddress: 'a@x.com', displayName: 'Alice' }],
        lastModifyingUser: { emailAddress: 'b@x.com', displayName: 'Bob' },
        sharingUser: { emailAddress: 'c@x.com', displayName: 'Carol' },
        permissions: [{ type: 'user', emailAddress: 'd@x.com', displayName: 'Dan' }],
      };
      const out = extractFromDriveFile(file);
      const byEmail = Object.fromEntries(out.map(p => [p.email, p]));
      assert.equal(byEmail['a@x.com'].role, 'owner');
      assert.equal(byEmail['b@x.com'].role, 'modifier');
      assert.equal(byEmail['c@x.com'].role, 'collaborator');
      assert.equal(byEmail['d@x.com'].role, 'collaborator');
    });

    it('returns [] for missing file', () => {
      assert.deepEqual(extractFromDriveFile(null), []);
      assert.deepEqual(extractFromDriveFile({}), []);
    });
  });

  describe('extractParticipants dispatch', () => {
    it('routes tldv via segments', () => {
      const out = extractParticipants({
        source: 'tldv',
        format: 'tldv',
        segments: [{ content: 'hi', metadata: { speaker: 'Eve' } }],
      });
      assert.equal(out.length, 1);
      assert.equal(out[0].name, 'Eve');
    });

    it('routes email with messages', () => {
      const out = extractParticipants({
        source: 'email',
        messages: [{ headers: { from: 'a@x.com' } }],
      });
      assert.equal(out.length, 1);
      assert.equal(out[0].email, 'a@x.com');
    });

    it('routes email with legacy string array fallback', () => {
      const out = extractParticipants({
        source: 'email',
        participantStrings: ['a@x.com'],
      });
      assert.equal(out.length, 1);
    });

    it('returns [] for unknown source', () => {
      assert.deepEqual(extractParticipants({ source: 'unknown' }), []);
    });
  });
});
