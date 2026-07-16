import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as shim from '../src/research/feed-poller.js';
import * as canonical from '../src/research/research-source-poller.js';

describe('feed-poller shim compatibility', () => {
  it('re-exports poller aliases', () => {
    assert.equal(shim.pollResearchSources, canonical.pollResearchSources);
    assert.equal(shim.pollResearchFeeds, canonical.pollResearchFeeds);
  });
});
