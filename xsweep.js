/*!
 * xsweep 1.0.0 - delete your X (Twitter) posts that got too few views.
 * https://github.com/GDLevSargsyan/xsweep  -  MIT
 *
 * HOW: open your own profile on x.com (the Posts tab), press F12 -> Console, paste this whole file, press Enter.
 * It is a DRY RUN by default: it only counts. Everything runs inside your tab: it clicks the buttons you would
 * click, makes no network requests of its own and sends nothing anywhere. Deleted posts cannot be restored.
 *
 * Change the settings without editing this file by running this line BEFORE you paste the script:
 *   window.XSWEEP_CONFIG = { DRY_RUN: false, BELOW_VIEWS: 25 };
 * While it runs:  XSWEEP.stats   XSWEEP.log   XSWEEP.stop = true
 */
(() => {
  'use strict';

  const DEFAULTS = {
    BELOW_VIEWS: 10,          // delete posts with FEWER views than this
    MIN_AGE_HOURS: 48,        // leave posts younger than this alone: they are still collecting views
    INCLUDE_REPLIES: false,   // false = posts only (run it on your Posts tab) / true = replies too (run it on your Replies tab)
    DRY_RUN: true,            // true = only count and list / false = really delete (asks once before it starts)
    MAX_DELETIONS: 0,         // stop after this many deletions, 0 = no limit (set 1 to try it on a single post first)
    DOWNLOAD_LOG: true,       // save a JSON list of the deleted posts when a real run ends
    PAUSE_MS: [350, 800],     // random pause after every deletion
    BREAK_EVERY: 100,         // a longer breather after this many deletions...
    BREAK_MS: [8000, 15000],  // ...of this length
    STALL_PATIENCE: 5,        // how many ~50 s waits a stuck timeline gets before the run counts as finished
    // The words X shows in YOUR interface language (English is built in). For another language, change these two:
    LABEL_DELETE: /^delete$/i,                             // the "Delete" item in a post's menu
    LABEL_VIEWS: /^([\d.,\s]+)\s+views?\b/i,               // the analytics link's label, e.g. "1234 views. View post analytics"
  };
  const LOG_KEY = 'xsweep_deleted_log';

  // ---- pure helpers (no DOM; unit-tested) --------------------------------------------------------------------------

  // Views of one post from its analytics link. null = unknown (then the post is never deleted).
  const parseViews = (label, text, labelViews) => {
    const l = (label || '').trim();
    const m = l.match(labelViews);
    if (m) return parseInt(m[1].replace(/\D/g, ''), 10);
    if (l && !(text || '').trim()) return 0;   // X prints no number at all for 0 views: the link has a label but no visible text
    return null;
  };

  // What to do with one post: 'delete' or the reason it stays.
  const decide = (p, cfg, now = Date.now()) => {
    if (p.hasContext) return 'skipped';                                  // pinned, reposted by you, ...
    if (p.views === null || Number.isNaN(p.views)) return 'unknownViews';
    if (p.views >= cfg.BELOW_VIEWS) return 'kept';
    if (Number.isNaN(p.when) || now - p.when < cfg.MIN_AGE_HOURS * 3600e3) return 'young';
    return 'delete';
  };

  const pathFor = (handle, cfg) => '/' + handle + (cfg.INCLUDE_REPLIES ? '/with_replies' : '');
  const onRightPage = (pathname, handle, cfg) => pathname.replace(/\/+$/, '').toLowerCase() === pathFor(handle, cfg).toLowerCase();

  // ---- the run (browser only) --------------------------------------------------------------------------------------

  async function run() {
    if (window.XSWEEP && window.XSWEEP.running) { console.warn('[xsweep] already running - set XSWEEP.stop = true to stop it'); return; }
    const cfg = { ...DEFAULTS, ...(window.XSWEEP_CONFIG || {}) };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rnd = ([a, b]) => a + Math.random() * (b - a);
    const waitFor = async (fn, ms = 4000, step = 60) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await sleep(step); }
      return null;
    };
    const say = (...a) => console.log('%c[xsweep]', 'color:#1d9bf0;font-weight:bold', ...a);

    // who is logged in, and are we on the right page?
    const sw = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    const handle = sw && (sw.innerText.match(/@(\w{1,15})/) || [])[1];
    if (!handle) { alert('xsweep: could not find your account. Open x.com while logged in and paste the script again. Nothing was done.'); return; }
    if (!onRightPage(location.pathname, handle, cfg)) {
      alert('xsweep: open ' + location.origin + pathFor(handle, cfg) + ' (the ' + (cfg.INCLUDE_REPLIES ? 'Replies' : 'Posts') +
        ' tab of your profile) and paste the script again. Nothing was done.');
      return;
    }
    if (!cfg.DRY_RUN && !confirm('xsweep will PERMANENTLY delete the ' + (cfg.INCLUDE_REPLIES ? 'posts and replies' : 'posts') + ' of @' + handle +
      ' that have fewer than ' + cfg.BELOW_VIEWS + ' views' + (cfg.MIN_AGE_HOURS ? ' and are older than ' + cfg.MIN_AGE_HOURS + ' h' : '') +
      '.\n\nPinned posts and reposts stay. Deleted posts cannot be restored.\n\nOK = start, Cancel = do nothing.')) { return; }

    const S = window.XSWEEP = {
      running: true, stop: false, handle, config: cfg, reason: '', failed: [],
      stats: { deleted: 0, wouldDelete: 0, kept: 0, young: 0, skipped: 0, unknownViews: 0, failed: 0 },
      log: cfg.DRY_RUN ? [] : (() => { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { return []; } })(),
    };
    const seen = new Set();

    // One timeline article -> a post of yours, or null (someone else's post, e.g. the parent of a reply).
    const readPost = a => {
      const t = a.querySelector('time');
      const link = t && t.closest('a');
      const m = link && (link.getAttribute('href') || '').match(/^\/([^/]+)\/status\/(\d+)$/);
      if (!m || m[1].toLowerCase() !== handle.toLowerCase()) return null;
      const an = a.querySelector('a[href$="/analytics"]');
      const tx = a.querySelector('[data-testid="tweetText"]');
      return {
        id: m[2],
        views: an ? parseViews(an.getAttribute('aria-label'), an.innerText, cfg.LABEL_VIEWS) : null,
        hasContext: !!a.querySelector('[data-testid="socialContext"]'),
        when: Date.parse(t.getAttribute('datetime')),
        text: tx ? tx.innerText.slice(0, 160) : '',
      };
    };

    // Menu "..." -> Delete -> confirm. Success = the article leaves the page.
    const removeArticle = async (a, id) => {
      a.scrollIntoView({ block: 'center' });
      await sleep(120);
      const caret = a.querySelector('[data-testid="caret"]');
      if (!caret) return 'no-menu-button';
      caret.click();
      const item = await waitFor(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(x => cfg.LABEL_DELETE.test(x.innerText.trim())));
      if (!item) { document.body.click(); return 'no-delete-item'; }
      item.click();
      const ok = await waitFor(() => document.querySelector('[data-testid="confirmationSheetConfirm"]'));
      if (!ok) return 'no-confirm-sheet';
      ok.click();
      const gone = () => !document.contains(a) && ![...document.querySelectorAll('article time')].some(t => (t.closest('a') || {}).href && t.closest('a').href.endsWith('/status/' + id));
      return (await waitFor(gone, 8000, 100)) ? 'ok' : 'still-there';
    };

    const save = () => { if (cfg.DRY_RUN) return; try { localStorage.setItem(LOG_KEY, JSON.stringify(S.log)); } catch (e) { /* storage full or blocked: the log is still in XSWEEP.log */ } };
    const retryButton = () => [...document.querySelectorAll('[role="button"]')].find(b => /^(retry|try again)$/i.test((b.innerText || '').trim()));
    const atBottom = () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 120;
    const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    // A lock / verification / suspension notice: never fight it, stop and let a human look.
    const blocked = () => {
      const t = [...document.querySelectorAll('[role="dialog"], [role="alert"], [role="alertdialog"]')].map(e => e.innerText).join(' ') + ' ' + document.title;
      return /locked|suspended|unusual activity|verify (you|your)|confirm you.?re human|temporarily restricted/i.test(t) ? t.replace(/\s+/g, ' ').slice(0, 160) : '';
    };

    say((cfg.DRY_RUN ? 'DRY RUN - nothing will be deleted. ' : 'REAL RUN. ') + '@' + handle + ' / ' + (cfg.INCLUDE_REPLIES ? 'posts and replies' : 'posts only') +
      ' / fewer than ' + cfg.BELOW_VIEWS + ' views / older than ' + cfg.MIN_AGE_HOURS + ' h.  Stop any time: XSWEEP.stop = true');
    window.scrollTo(0, 0);
    await sleep(1500);

    let idle = 0, stalls = 0, fails = 0;
    while (!S.stop) {
      let acted = false, sawNew = false;
      for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
        const p = readPost(a);
        if (!p || seen.has(p.id)) continue;
        sawNew = true;
        seen.add(p.id);
        const d = decide(p, cfg);
        if (d !== 'delete') { S.stats[d]++; continue; }
        const entry = { id: p.id, views: p.views, date: new Date(p.when).toISOString(), text: p.text };
        if (cfg.DRY_RUN) { S.stats.wouldDelete++; S.log.push(entry); continue; }
        const res = await removeArticle(a, p.id);
        if (res === 'ok') {
          S.stats.deleted++; fails = 0;
          S.log.push(entry);
          if (S.stats.deleted % 25 === 0) { save(); say(JSON.stringify(S.stats)); }
          if (cfg.MAX_DELETIONS && S.stats.deleted >= cfg.MAX_DELETIONS) S.stop = true;
          await sleep(cfg.BREAK_EVERY && S.stats.deleted % cfg.BREAK_EVERY === 0 ? rnd(cfg.BREAK_MS) : rnd(cfg.PAUSE_MS));
        } else {
          S.stats.failed++; S.failed.push({ id: p.id, why: res }); fails++;
          console.warn('[xsweep] could not delete ' + p.id + ': ' + res);
          escape();
          const b = blocked(); if (b) { S.reason = 'blocked: ' + b; console.error('[xsweep] ' + S.reason); S.stop = true; }
          if (fails >= 5) { S.reason = S.reason || '5 failures in a row'; console.error('[xsweep] 5 failures in a row, stopping (rate limit, or X changed its page)'); S.stop = true; }
          await sleep(fails * 4000);
        }
        acted = true;
        break;   // the page changed: read it again from the start
      }
      if (acted) { idle = 0; continue; }
      if (sawNew || !atBottom()) idle = 0; else idle++;   // not at the bottom = still walking over posts already seen, not a stall
      if (idle > 0 && idle % 12 === 0) {   // at the bottom, nothing new for ~10 s: X is slow, rate-limiting or stuck
        const rb = retryButton(); if (rb) rb.click();
        const b = blocked(); if (b) { S.reason = 'blocked: ' + b; console.error('[xsweep] ' + S.reason); S.stop = true; break; }
        stalls++;
        console.warn('[xsweep] the timeline does not load more (' + stalls + '/' + cfg.STALL_PATIENCE + ')');
        if (stalls >= cfg.STALL_PATIENCE) { S.reason = S.reason || 'end of the timeline'; break; }
        window.scrollBy(0, -Math.round(window.innerHeight * 3)); await sleep(700);   // leave the bottom and come back so the loader fires again
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(45000);
      } else if (sawNew) stalls = 0;
      window.scrollBy(0, Math.round(window.innerHeight * 0.8));
      await sleep(500 + Math.random() * 300);
    }

    S.running = false;
    save();
    const st = S.stats;
    say('finished' + (S.reason ? ' (' + S.reason + ')' : S.stop ? ' (stopped)' : '') + '. ' +
      (cfg.DRY_RUN ? 'Would delete ' + st.wouldDelete : 'Deleted ' + st.deleted) +
      ' / kept ' + st.kept + ' with enough views / ' + st.young + ' too young / ' + st.skipped + ' pinned or reposted / ' + st.unknownViews + ' with unknown views' +
      (st.failed ? ' / ' + st.failed + ' failed' : '') + '.');
    if (cfg.DRY_RUN) {
      if (S.log.length) { console.table(S.log.slice(0, 25).map(e => ({ views: e.views, date: e.date.slice(0, 10), text: e.text.slice(0, 80) }))); }
      say('That was only a count. To delete for real, run  window.XSWEEP_CONFIG = { DRY_RUN: false }  and paste the script again.');
    } else if (cfg.DOWNLOAD_LOG && S.log.length) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(S.log, null, 1)], { type: 'application/json' }));
      a.download = 'xsweep-deleted-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
    }
  }

  const api = { DEFAULTS, parseViews, decide, pathFor, onRightPage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node (the tests): export the helpers, run nothing
  if (typeof document !== 'undefined' && typeof window !== 'undefined') run().catch(e => console.error('[xsweep]', e));
})();
