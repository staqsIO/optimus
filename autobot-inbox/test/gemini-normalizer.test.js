import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGemini,
  parseGeminiHeader,
  parseInvitedLine,
} from '../../lib/rag/normalizers/gemini.js';
import {
  extractFromGeminiSegments,
  extractParticipants,
} from '../../lib/rag/participants/extractors.js';

const NOTES_SAMPLE = `Apr 24, 2026
Round Up Call
Invited Michael Maibach Patrick King Dustin Powers Casey Boone Eric Gang
Attachments Round Up Call
Meeting records Transcript


Summary
Meeting focused on project alignment and strategy for scaling hardware and software consulting via new ventures.

Formula Project Strategic Challenges
Leadership deficiencies and communication gaps regarding the Formula project have created frustration. A decision was made to delay further action on the current structure until a customer win occurs.

Developer Partnership and Model
The team refined a model to leverage a third-party developer by marking up services for regulated industries. This approach focuses on deploying a scalable, replicable core module.


Next steps
[Michael Maibach, Eric Gang] Review Proposal: Review the Coastal project proposal together next week. Finalize the document for submission.
[Casey Boone] Contact TJ: Call TJ immediately to discuss the project. Report back findings on the discussion.
[Eric Gang] Reorganize Development: Reorganize development team priorities next week. Refocus what work is getting executed and where.


Details
Meeting Wrap-Up and Transition Pool Discussion: The participants concluded the discussion by ensuring general comfort and alignment regarding the current position of their projects.
Lawyer and Warehouse Call Lineups: Regarding the call with the lawyer, Michael Maibach suggested that only them and Dustin Powers should attend (00:00:53).
Frustrations with Formula Project and Nova Farms: Eric Gang expressed frustration with the Formula project (00:02:12).


You should review Gemini's notes to make sure they're accurate. Get tips and learn how Gemini takes notes
How is the quality of these specific notes? Take a short survey to let us know your feedback, including how helpful the notes were for your needs.
`;

const TRANSCRIPT_SAMPLE = `Apr 24, 2026
Round Up Call - Transcript
00:00:00

Michael Maibach: goal is here. It's like, let's make this happen, you know?
Casey Boone: Yeah.
Michael Maibach: All right.


00:00:53

Michael Maibach: I have a really busy day for UMB on Tuesday.
Casey Boone: Yeah.
Patrick King: Pat.

Transcription ended after 00:55:19

This editable transcript was computer generated and might contain errors.
`;

const COMBINED_SAMPLE = NOTES_SAMPLE + '\n\n' + TRANSCRIPT_SAMPLE;

describe('normalizers/gemini', () => {
  describe('parseInvitedLine', () => {
    it('splits the space-joined attendee list into First+Last pairs', () => {
      const out = parseInvitedLine('Michael Maibach Patrick King Dustin Powers Casey Boone Eric Gang');
      assert.deepEqual(out, [
        'Michael Maibach',
        'Patrick King',
        'Dustin Powers',
        'Casey Boone',
        'Eric Gang',
      ]);
    });

    it('returns empty for blank input', () => {
      assert.deepEqual(parseInvitedLine(''), []);
    });
  });

  describe('parseGeminiHeader', () => {
    it('captures date, title, and invitees on a notes-tab paste', () => {
      const lines = NOTES_SAMPLE.split('\n');
      const { header, bodyStart } = parseGeminiHeader(lines);
      assert.equal(header.date, 'Apr 24, 2026');
      assert.equal(header.title, 'Round Up Call');
      assert.equal(header.invitees.length, 5);
      assert.ok(bodyStart > 0);
    });

    it('strips the "- Transcript" suffix from the title on a transcript-tab paste', () => {
      const lines = TRANSCRIPT_SAMPLE.split('\n');
      const { header } = parseGeminiHeader(lines);
      assert.equal(header.title, 'Round Up Call');
    });
  });

  describe('normalizeGemini (notes tab)', () => {
    const segments = normalizeGemini(NOTES_SAMPLE);

    it('emits a header segment carrying invitees in metadata', () => {
      const header = segments.find(s => s.metadata?.section === 'header');
      assert.ok(header, 'expected a header segment');
      assert.deepEqual(header.metadata.invitees, [
        'Michael Maibach',
        'Patrick King',
        'Dustin Powers',
        'Casey Boone',
        'Eric Gang',
      ]);
    });

    it('tags summary paragraphs', () => {
      const summary = segments.filter(s => s.metadata?.section === 'summary');
      assert.ok(summary.length >= 3, 'expected the overview + topic paragraphs');
      assert.ok(summary[0].content.startsWith('Meeting focused on'));
    });

    it('parses next-step assignees out of the [Owner, ...] prefix', () => {
      const steps = segments.filter(s => s.metadata?.section === 'next_steps');
      assert.equal(steps.length, 3);
      const review = steps.find(s => s.metadata.topic === 'Review Proposal');
      assert.ok(review, 'expected the Review Proposal step');
      assert.deepEqual(review.metadata.assignees, ['Michael Maibach', 'Eric Gang']);
      assert.ok(review.content.startsWith('Review Proposal:'));
    });

    it('extracts inline timestamps in the Details section', () => {
      const details = segments.filter(s => s.metadata?.section === 'details');
      assert.ok(details.length >= 3, 'expected the three sample detail topics');
      const lawyer = details.find(s => s.metadata.topic?.startsWith('Lawyer'));
      assert.equal(lawyer.metadata.timestamp, '00:00:53');
      assert.ok(!/\(00:00:53\)/.test(lawyer.content));
    });

    it('strips the trailing Gemini UI prompts', () => {
      const joined = segments.map(s => s.content).join('\n');
      assert.ok(!/Take a short survey/i.test(joined));
      assert.ok(!/review Gemini'?s notes/i.test(joined));
    });

    it('handles empty input', () => {
      assert.deepEqual(normalizeGemini(''), []);
      assert.deepEqual(normalizeGemini(null), []);
    });
  });

  describe('normalizeGemini (transcript tab)', () => {
    const segments = normalizeGemini(TRANSCRIPT_SAMPLE);

    it('emits one segment per Speaker: utterance line', () => {
      const turns = segments.filter(s => s.metadata?.section === 'transcript');
      assert.equal(turns.length, 6);
      assert.equal(turns[0].metadata.speaker, 'Michael Maibach');
      assert.ok(turns[0].content.startsWith('goal is here'));
    });

    it('attaches the most-recent bare timestamp marker to each turn', () => {
      const turns = segments.filter(s => s.metadata?.section === 'transcript');
      assert.equal(turns[0].metadata.timestamp, '00:00:00');
      assert.equal(turns[3].metadata.timestamp, '00:00:53');
      assert.equal(turns[5].metadata.speaker, 'Patrick King');
    });

    it('drops the "Transcription ended" footer + boilerplate notice', () => {
      const joined = segments.map(s => s.content).join('\n');
      assert.ok(!/transcription ended/i.test(joined));
      assert.ok(!/this editable transcript/i.test(joined));
    });
  });

  describe('normalizeGemini (combined notes + transcript)', () => {
    const segments = normalizeGemini(COMBINED_SAMPLE);

    it('keeps notes sections intact when the transcript tab is appended', () => {
      const sections = new Set(segments.map(s => s.metadata?.section));
      for (const expected of ['header', 'summary', 'next_steps', 'details', 'transcript']) {
        assert.ok(sections.has(expected), `expected ${expected} segments`);
      }
    });

    it('does not duplicate the date/title between the two tabs', () => {
      const headers = segments.filter(s => s.metadata?.section === 'header');
      assert.equal(headers.length, 1);
    });
  });

  describe('extractFromGeminiSegments', () => {
    it('collects every invitee plus next-step owners from a notes-only paste', () => {
      const segments = normalizeGemini(NOTES_SAMPLE);
      const out = extractFromGeminiSegments(segments);
      const names = out.map(p => p.name).sort();
      assert.deepEqual(names, [
        'Casey Boone',
        'Dustin Powers',
        'Eric Gang',
        'Michael Maibach',
        'Patrick King',
      ]);
      // Eric appears in two action items, Patrick in none, so both stay 'attendee'.
      const eric = out.find(p => p.name === 'Eric Gang');
      const patrick = out.find(p => p.name === 'Patrick King');
      assert.equal(eric.turns, 2);
      assert.equal(patrick.turns, 0);
      assert.equal(eric.role, 'attendee');
    });

    it('promotes participants with transcript turns to role=speaker', () => {
      const segments = normalizeGemini(COMBINED_SAMPLE);
      const out = extractFromGeminiSegments(segments);
      const mike = out.find(p => p.name === 'Michael Maibach');
      const patrick = out.find(p => p.name === 'Patrick King');
      assert.equal(mike.role, 'speaker');
      assert.ok(mike.turns >= 4, `Mike turn count was ${mike.turns}`);
      // Patrick spoke once in the transcript, so he gets promoted too.
      assert.equal(patrick.role, 'speaker');
    });

    it('routes through the dispatcher for format=gemini', () => {
      const segments = normalizeGemini(NOTES_SAMPLE);
      const out = extractParticipants({ format: 'gemini', segments });
      assert.equal(out.length, 5);
      assert.ok(out.every(p => p.role === 'attendee'));
    });
  });
});
