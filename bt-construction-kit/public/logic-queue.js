// Logic Pro stemming queue (Bill 2026-11-23): shows the song folders waiting for
// Logic Pro's Stem Splitter (LOGIC_QUEUE/ on the Drive) and a button that hands the
// Mac to Claude so it can stem them. Shown only while something is queued or the
// Mac is handed over. Server side: /api/logic-queue in server.js.
(function () {
  let box = null, list = null, head = null, btn = null, note = null, open = true;
  function build() {
    box = document.createElement('div');
    box.id = 'logic-queue-panel';
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9000;width:340px;max-height:46vh;display:flex;flex-direction:column;' +
      'background:#15181d;color:#e6e6e6;border:1px solid #f1c40f;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.5);font:13px/1.35 system-ui,sans-serif';
    head = document.createElement('div');
    head.style.cssText = 'padding:8px 10px;font-weight:600;cursor:pointer;border-bottom:1px solid #2a2f36';
    head.title = 'Click to fold or unfold';
    head.addEventListener('click', () => { open = !open; paint(last); });
    list = document.createElement('ol');
    list.style.cssText = 'margin:0;padding:6px 10px 6px 30px;overflow:auto;flex:1';
    note = document.createElement('div');
    note.style.cssText = 'padding:0 10px 6px;color:#aab';
    btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText = 'margin:0 10px 10px;padding:7px 10px;border-radius:6px;border:1px solid #f1c40f;background:#2a2410;color:#f1c40f;font-weight:600;cursor:pointer';
    btn.addEventListener('click', toggle);
    box.append(head, list, note, btn);
    document.body.appendChild(box);
  }
  let last = { pending: [], handover: null };
  function paint(q) {
    last = q;
    const n = (q.pending || []).length;
    if (!n && !q.handover) { if (box) box.style.display = 'none'; return; }
    if (!box) build();
    box.style.display = 'flex';
    head.textContent = (open ? '▾ ' : '▸ ') + 'Logic stemming queue: ' + n + (n === 1 ? ' folder' : ' folders') + ' pending';
    list.style.display = note.style.display = btn.style.display = open ? '' : 'none';
    list.textContent = '';
    for (const p of q.pending) {
      const li = document.createElement('li');
      li.textContent = p.folder;
      if (p.title) li.title = p.title + (p.artist ? ' — ' + p.artist : '') + (p.queued_at ? '\nqueued ' + p.queued_at : '');
      list.appendChild(li);
    }
    if (q.handover) {
      const t = q.handover.requested_at ? new Date(q.handover.requested_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      note.textContent = 'Mac handed to Claude' + (t ? ' at ' + t : '') + '. The screen stays awake for ' + (q.handover.hours || 4) + ' hours. Please leave Logic Pro alone until Claude reports back.';
      btn.textContent = 'Take the Mac back';
    } else {
      note.textContent = 'Claude stems these in Logic Pro (about 3 minutes a song) while you are away from the Mac.';
      btn.textContent = 'Give Claude the Mac to stem these';
    }
  }
  async function refresh() {
    try { paint(await (await fetch('/api/logic-queue', { cache: 'no-store' })).json()); } catch (e) {}
  }
  async function toggle() {
    btn.disabled = true;
    try { await fetch('/api/logic-queue/handover', { method: last.handover ? 'DELETE' : 'POST' }); } catch (e) {}
    btn.disabled = false;
    refresh();
  }
  setInterval(refresh, 30000);
  refresh();
})();
