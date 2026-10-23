(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PetSpeech = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const duration = text => Math.min(10000, Math.max(6000, 5000 + Array.from(text).length * 65));
  const localImage = path => typeof path === 'string' && /^assets\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|gif|webp)$/.test(path);
  function create({ root, text, image, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, reducedMotion = () => false }) {
    let active = true, covered = false, destroyed = false, current = null, revision = 0, timer = null, fadeTimer = null;
    const seen = new Set();
    function cancel() {
      if (timer !== null) clearTimer(timer);
      if (fadeTimer !== null) clearTimer(fadeTimer);
      timer = fadeTimer = null;
    }
    function render(on) {
      if (on && (root.hidden || root.dataset.state === 'leaving')) {
        root.hidden = false;
        root.dataset.state = 'entering';
        // Commit the transparent state before fading in, without a queued frame/timer.
        if (!reducedMotion()) void root.offsetWidth;
      }
      root.hidden = !on;
      root.dataset.state = on ? 'visible' : 'hidden';
      root.classList.toggle('has-image', Boolean(on && current?.image));
      text.textContent = on && current ? current.text : '';
      image.hidden = !(on && current?.image);
      if (on && current?.image) {
        if (image.getAttribute('src') !== current.image) image.setAttribute('src', current.image);
        image.alt = current.alt;
      } else { image.removeAttribute('src'); image.alt = ''; }
    }
    function dismiss() {
      cancel(); revision++;
      if (!current) { render(false); return; }
      current = null;
      if (active && !covered && !reducedMotion()) {
        root.dataset.state = 'leaving';
        fadeTimer = setTimer(() => { fadeTimer = null; render(false); }, 250);
      } else render(false);
    }
    function arm() {
      cancel();
      if (!current || !active || covered) { render(false); return; }
      if (current.remaining <= 0) { dismiss(); return; }
      current.deadline = now() + current.remaining;
      render(true);
      timer = setTimer(dismiss, current.remaining);
    }
    function show({ id, text: words, priority = 1, image: path, alt = '' } = {}) {
      if (destroyed || !active || typeof words !== 'string' || !words.trim()) return null;
      if (id !== undefined && seen.has(id)) return null;
      priority = Number.isFinite(priority) ? priority : 1;
      if (current && priority < current.priority) return null;
      if (id !== undefined) { seen.add(id); if (seen.size > 128) seen.delete(seen.values().next().value); }
      const token = ++revision;
      const content = Array.from(words.trim()).slice(0, 280).join('');
      current = { token, text: content, priority, remaining: duration(content), image: localImage(path) ? path : null, alt: typeof alt === 'string' ? alt : '' };
      arm(); return token;
    }
    function attachImage(token, path, alt = '') {
      if (destroyed || !active || !current || current.token !== token || !localImage(path)) return false;
      current.image = path; current.alt = typeof alt === 'string' ? alt : '';
      if (!covered) render(true);
      return true;
    }
    function setCovered(value) {
      if (destroyed || covered === value) return;
      if (value && current && active) current.remaining = Math.max(0, (current.deadline ?? now() + current.remaining) - now());
      covered = value; cancel();
      if (covered) render(false); else arm();
    }
    function setActive(value) {
      if (destroyed || active === value) return;
      active = value;
      if (!value) { cancel(); current = null; revision++; render(false); }
    }
    function destroy() { destroyed = true; active = false; current = null; revision++; cancel(); render(false); }
    render(false);
    return Object.freeze({ show, attachImage, setCovered, setActive, dismiss, destroy });
  }
  return Object.freeze({ create, duration });
});
