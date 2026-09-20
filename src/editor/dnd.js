// Pointer-event drag and drop with a computed insertion marker.
// Technique (geometry-based insertion line rather than a swap-on-hover list) is adapted from
// silverweed/tiers (WTFPL), reimplemented for pointer events so touch works without a fallback flag.

const DRAG_THRESHOLD = 5;

export function attachDnD(root, { onDrop }) {
  let state = null;

  const marker = document.createElement('div');
  marker.className = 'bt-marker';
  marker.setAttribute('aria-hidden', 'true');

  function cleanup() {
    if (!state) return;
    state.ghost?.remove();
    state.source?.classList.remove('bt-dragging');
    marker.remove();
    document.body.classList.remove('bt-dragging-active');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('keydown', onKey, true);
    state = null;
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
  }

  function beginDrag() {
    const rect = state.source.getBoundingClientRect();
    const ghost = state.source.cloneNode(true);
    ghost.classList.add('bt-ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    state.offsetX = state.startX - rect.left;
    state.offsetY = state.startY - rect.top;
    document.body.appendChild(ghost);
    state.ghost = ghost;
    state.source.classList.add('bt-dragging');
    document.body.classList.add('bt-dragging-active');
    state.dragging = true;
  }

  // Returns {row, index} for the current pointer position, or null when outside any row.
  function locate(x, y) {
    if (state.ghost) state.ghost.style.visibility = 'hidden';
    const under = document.elementFromPoint(x, y);
    if (state.ghost) state.ghost.style.visibility = '';
    if (!under) return null;
    const row = under.closest('.bt-items');
    if (!row || !root.contains(row)) return null;
    const siblings = [...row.querySelectorAll('.bt-item')].filter((el) => el !== state.source);
    let index = siblings.length;
    for (let i = 0; i < siblings.length; i += 1) {
      const r = siblings[i].getBoundingClientRect();
      // Same visual line as the pointer, and the pointer is left of this item's midpoint.
      const onThisLine = y < r.bottom;
      if (onThisLine && (y < r.top || x < r.left + r.width / 2)) { index = i; break; }
    }
    return { row, index, siblings };
  }

  function onMove(e) {
    if (!state) return;
    if (!state.dragging) {
      if (Math.hypot(e.clientX - state.startX, e.clientY - state.startY) < DRAG_THRESHOLD) return;
      beginDrag();
    }
    e.preventDefault();
    state.ghost.style.transform = `translate(${e.clientX - state.offsetX}px, ${e.clientY - state.offsetY}px)`;
    const hit = locate(e.clientX, e.clientY);
    if (!hit) { marker.remove(); state.target = null; return; }
    const ref = hit.siblings[hit.index];
    if (ref) hit.row.insertBefore(marker, ref); else hit.row.appendChild(marker);
    state.target = { tier: hit.row.dataset.tier, index: hit.index };
  }

  function onUp() {
    if (!state) return;
    const { dragging, target, source } = state;
    const id = source.dataset.id;
    cleanup();
    if (dragging && target) onDrop(id, target.tier, target.index);
  }

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('[data-move]')) return;      // the nudge buttons are not drag handles
    const item = e.target.closest('.bt-item');
    if (!item || !root.contains(item)) return;
    state = { source: item, startX: e.clientX, startY: e.clientY, dragging: false, target: null };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey, true);
  });

  // Suppress the click that follows a drag so a linked cover does not navigate on drop.
  root.addEventListener('click', (e) => {
    if (document.body.classList.contains('bt-dragging-active')) {
      e.preventDefault(); e.stopPropagation();
    }
  }, true);

  return { destroy: cleanup, wasDragging: () => !!state?.dragging };
}
