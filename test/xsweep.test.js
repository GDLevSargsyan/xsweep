'use strict';
// The pure parts of xsweep (view parsing, the keep/delete decision, page checks). The browser part is not run here:
// the script does nothing when it is loaded without a DOM, so these tests never touch X.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, parseViews, decide, pathFor, onRightPage } = require('../xsweep.js');

const HOUR = 3600e3;
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const post = (over = {}) => ({ views: 3, hasContext: false, when: NOW - 100 * HOUR, ...over });

test('defaults are the safe ones', () => {
  assert.equal(DEFAULTS.DRY_RUN, true);
  assert.equal(DEFAULTS.INCLUDE_REPLIES, false);
  assert.equal(DEFAULTS.BELOW_VIEWS, 10);
  assert.equal(DEFAULTS.MIN_AGE_HOURS, 48);
  assert.equal(DEFAULTS.MAX_DELETIONS, 0);
});

test('parseViews reads the analytics label', () => {
  const re = DEFAULTS.LABEL_VIEWS;
  assert.equal(parseViews('325096 views. View post analytics', '325K', re), 325096);
  assert.equal(parseViews('1 view. View post analytics', '1', re), 1);
  assert.equal(parseViews('1,234 views. View post analytics', '1.2K', re), 1234);
  assert.equal(parseViews('10 Views', '10', re), 10);
});

test('parseViews: no visible number means 0 views', () => {
  assert.equal(parseViews('View post analytics', '', DEFAULTS.LABEL_VIEWS), 0);
  assert.equal(parseViews('View post analytics', '  \n', DEFAULTS.LABEL_VIEWS), 0);
});

test('parseViews: anything it cannot read is unknown, never 0', () => {
  const re = DEFAULTS.LABEL_VIEWS;
  assert.equal(parseViews('Voir les statistiques', '1,2 k', re), null);   // another language, a number is shown
  assert.equal(parseViews('', '', re), null);                            // no analytics link at all
  assert.equal(parseViews(null, null, re), null);
});

test('decide: a post with too few views that is old enough is deleted', () => {
  assert.equal(decide(post(), DEFAULTS, NOW), 'delete');
  assert.equal(decide(post({ views: 0 }), DEFAULTS, NOW), 'delete');
  assert.equal(decide(post({ views: 9 }), DEFAULTS, NOW), 'delete');
});

test('decide: the threshold is "fewer than"', () => {
  assert.equal(decide(post({ views: 10 }), DEFAULTS, NOW), 'kept');
  assert.equal(decide(post({ views: 5000 }), DEFAULTS, NOW), 'kept');
  assert.equal(decide(post({ views: 24 }), { ...DEFAULTS, BELOW_VIEWS: 25 }, NOW), 'delete');
});

test('decide: young posts, pinned/reposted posts and unknown views are left alone', () => {
  assert.equal(decide(post({ when: NOW - 47 * HOUR }), DEFAULTS, NOW), 'young');
  assert.equal(decide(post({ when: NOW - 48 * HOUR }), DEFAULTS, NOW), 'delete');
  assert.equal(decide(post({ when: NaN }), DEFAULTS, NOW), 'young');
  assert.equal(decide(post({ hasContext: true }), DEFAULTS, NOW), 'skipped');
  assert.equal(decide(post({ views: null }), DEFAULTS, NOW), 'unknownViews');
  assert.equal(decide(post({ views: NaN }), DEFAULTS, NOW), 'unknownViews');
  assert.equal(decide(post({ when: NOW - 1 * HOUR }), { ...DEFAULTS, MIN_AGE_HOURS: 0 }, NOW), 'delete');
});

test('decide: context and unknown views win over everything else', () => {
  assert.equal(decide(post({ hasContext: true, views: 0 }), DEFAULTS, NOW), 'skipped');
  assert.equal(decide(post({ views: null, when: NOW - 1000 * HOUR }), DEFAULTS, NOW), 'unknownViews');
});

test('page check: posts-only runs on the Posts tab, replies on the Replies tab', () => {
  assert.equal(pathFor('Someone', DEFAULTS), '/Someone');
  assert.equal(pathFor('Someone', { ...DEFAULTS, INCLUDE_REPLIES: true }), '/Someone/with_replies');
  assert.equal(onRightPage('/someone', 'Someone', DEFAULTS), true);
  assert.equal(onRightPage('/someone/', 'Someone', DEFAULTS), true);
  assert.equal(onRightPage('/someone/with_replies', 'Someone', DEFAULTS), false);
  assert.equal(onRightPage('/someone/with_replies', 'Someone', { ...DEFAULTS, INCLUDE_REPLIES: true }), true);
  assert.equal(onRightPage('/home', 'Someone', DEFAULTS), false);
});
