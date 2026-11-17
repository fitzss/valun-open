// The worked example on the home page (public/story-fragment.html, in home.html's <section id="how">). Without this
// script its five steps stay stacked, each with its picture, its text and its table, and the step list links to them.
// With it, a stepper shows one step at a time:
//   - the step list's links become buttons (the current one has aria-current="step");
//   - Previous step and Next step sit right under the step list, above every step, so they never move as the steps'
//     heights change; a second pair follows the step (story.css hides it where a step fits on the screen beside its
//     picture: 900px wide and 820px tall or more), and using
//     it brings the step list back into view and moves focus to the same button above, so focus is never left off
//     screen on a button that moved;
//   - the left and right arrow keys move a step while focus is on the step list or on those buttons (Home and End,
//     on the step list, go to the first and the last step).
// A change the reader makes is announced politely ("Step 3 of 5: …"); nothing changes by itself, and when focus moves
// to a step list button the button itself says where the reader is. Motion is CSS only (story.css), and only without
// prefers-reduced-motion. A link to a step (#story-step-3) opens that step.

const STEP_ID = /^#story-step-(\d+)$/;

// Turns the example under `root` (the element with data-story) into a stepper and returns its parts (for tests), or
// returns null when the markup is not the example's, and then changes nothing. `env` stands in for the page's globals.
export function enhance(root, env = {}) {
  const doc = env.document ?? globalThis.document, loc = env.location ?? globalThis.location;
  const list = root?.querySelector('.story-steps'), track = root?.querySelector('.story-track');
  const steps = list ? [...list.children].filter(el => el.classList.contains('story-step')) : [];
  const links = track ? [...track.querySelectorAll('a')] : [];
  if (!doc || !list || steps.length < 2 || links.length !== steps.length || root.classList.contains('is-stepper')) return null;
  const titles = steps.map(s => (s.querySelector('.story-step-name')?.textContent ?? '').replace(/\s+/g, ' ').trim());
  let current = -1;

  const buttons = links.map((a, i) => {
    const b = doc.createElement('button');
    b.setAttribute('type', 'button');
    for (const n of [...a.childNodes]) b.append(n);
    a.replaceWith(b);
    b.addEventListener('click', () => go(i, 'click'));
    return b;
  });
  // The pair above the step, and the pair at its foot; each of the foot's buttons hands focus to its twin above.
  const prev = pagerButton(doc, 'Previous step'), next = pagerButton(doc, 'Next step');
  const prevEnd = pagerButton(doc, 'Previous step'), nextEnd = pagerButton(doc, 'Next step');
  const above = new Map([[prevEnd, prev], [nextEnd, next]]);
  prev.addEventListener('click', () => go(current - 1, 'pager'));
  next.addEventListener('click', () => go(current + 1, 'pager'));
  prevEnd.addEventListener('click', () => go(current - 1, 'end', prev));
  nextEnd.addEventListener('click', () => go(current + 1, 'end', next));
  const pager = pagerOf(doc, 'story-pager', prev, next), pagerEnd = pagerOf(doc, 'story-pager is-end', prevEnd, nextEnd);
  const status = doc.createElement('p');
  status.className = 'story-sr';
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  track.after(pager);
  list.after(pagerEnd, status);

  root.addEventListener('keydown', e => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const onTrack = buttons.includes(e.target), onPager = e.target === prev || e.target === next, onEnd = above.has(e.target);
    if (!onTrack && !onPager && !onEnd) return;
    const to = e.key === 'ArrowRight' ? current + 1 : e.key === 'ArrowLeft' ? current - 1
      : onTrack && e.key === 'Home' ? 0 : onTrack && e.key === 'End' ? steps.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    if (onEnd) go(to, 'end', above.get(e.target)); else go(to, onTrack ? 'track-key' : 'key');
  });

  // `via`: null when the page opens (no announcement, no motion); otherwise what the reader used. `then`: the button
  // above the step that takes the focus after the foot's pair was used.
  function go(i, via = null, then = null) {
    if (i < 0 || i >= steps.length || i === current) return;
    current = i;
    steps.forEach((s, k) => {
      if (k === i) s.removeAttribute('hidden'); else s.setAttribute('hidden', '');
      s.classList.toggle('is-entering', k === i && via !== null);
    });
    buttons.forEach((b, k) => { if (k === i) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
    for (const b of [prev, prevEnd]) setDisabled(b, i === 0);
    for (const b of [next, nextEnd]) setDisabled(b, i === steps.length - 1);
    if (via === null) return;
    if (via === 'track-key') buttons[i].focus();   // the focused button says which step this is
    else status.textContent = `Step ${i + 1} of ${steps.length}: ${titles[i]}`;
    if (via === 'end') { reveal(); then?.focus({preventScroll: true}); }
  }
  // After the foot's Previous or Next (a phone, at the end of a long step), bring the step list, the pair above and the
  // new step's start into view.
  function reveal() {
    const r = track.getBoundingClientRect?.();
    if (r && r.top < 0) track.scrollIntoView?.({block: 'start'});
  }

  root.classList.add('is-stepper');
  const m = STEP_ID.exec(loc?.hash ?? ''), linked = m ? Number(m[1]) - 1 : -1;
  go(linked >= 0 && linked < steps.length ? linked : 0);
  return {go: (i, via = 'pager') => go(i, via), get current() { return current; }, status, prev, next, prevEnd, nextEnd, buttons};
}

function pagerOf(doc, className, ...buttons) {
  const d = doc.createElement('div');
  d.className = className;
  d.append(...buttons);
  return d;
}

function pagerButton(doc, label) {
  const b = doc.createElement('button');
  b.setAttribute('type', 'button');
  b.className = 'btn';
  b.textContent = label;
  return b;
}
// An end of the story: the button stays focusable (focus never drops to the page) but does nothing.
function setDisabled(b, off) { if (off) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled'); }

if (typeof document !== 'undefined') {
  const root = document.querySelector('[data-story]');
  if (root) enhance(root);
}
