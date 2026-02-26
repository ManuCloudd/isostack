/* IsoStack — app.js */

let currentPage = 1;
let currentFilters = {};
let currentView = 'grid';
let currentSort = 'date_desc';
let currentGroupBy = false;
let filterFavorites = false;
let selectMode = false;
let selectedIds = new Set();
let pollingInterval = null;
let searchTimeout = null;
let cachedISOs = [];
let cachedPages = 1;

// ── INIT ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadISOs();
  loadStats();
  loadSystemInfo();

  document.getElementById('btnGrid').addEventListener('click', () => setView('grid'));
  document.getElementById('btnList').addEventListener('click', () => setView('list'));
  document.getElementById('btnGroup').addEventListener('click', toggleGroupBy);
  document.getElementById('btnSelect').addEventListener('click', toggleSelectMode);
  document.getElementById('btnStats').addEventListener('click', openStats);
  document.getElementById('btnMaintenance').addEventListener('click', openMaintenance);
  document.getElementById('sortSelect').addEventListener('change', e => { currentSort = e.target.value; renderData(); });
  document.getElementById('filterCategory').addEventListener('change', applyFilters);
  document.getElementById('filterOS').addEventListener('change', applyFilters);
  document.getElementById('filterArch').addEventListener('change', applyFilters);
  document.getElementById('filterEdition').addEventListener('change', applyFilters);
  document.getElementById('filterSearch').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(applyFilters, 250);
  });
  document.getElementById('perPageSelect').addEventListener('change', () => {
    currentPage = 1; loadISOs();
  });

  // Clic sur le hint drag dans le header → ouvre modal upload
  document.getElementById('dropHint')?.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    openModal('modalAdd'); switchTab('upload');
  });

  document.getElementById('btnAdd').addEventListener('click', () => openModal('modalAdd'));
  document.getElementById('btnBrowse').addEventListener('click', () => { openModal('modalBrowse'); runScan(); });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('formURL').addEventListener('submit', submitFromURL);
  document.getElementById('formUpload').addEventListener('submit', submitUpload);
  document.getElementById('formEdit').addEventListener('submit', submitEdit);

  const dz = document.getElementById('dropZone');
  dz.addEventListener('click', () => document.getElementById('fileInput').click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleFileSelected(e.dataTransfer.files[0]);
  });
  document.getElementById('fileInput').addEventListener('change', e => {
    if (e.target.files[0]) handleFileSelected(e.target.files[0]);
  });

  document.querySelectorAll('.modal-overlay').forEach(o => {
    o.addEventListener('click', e => { if (e.target === o) closeAllModals(); });
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllModals(); });
});

// ── UTILS ─────────────────────────────────────────────────────────

const svg = (id, size = 14) =>
  `<svg width="${size}" height="${size}" style="flex-shrink:0"><use href="#ic-${id}"/></svg>`;

const esc = s => s ? String(s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';

function fmtSize(b) {
  if (!b) return '—';
  const u = ['B','KB','MB','GB','TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

function osIcon(f) {
  if (!f) return 'disc';
  f = f.toLowerCase();
  if (/windows/.test(f)) return 'windows';
  if (/freebsd|openbsd|netbsd/.test(f)) return 'bsd';
  if (/proxmox|truenas|unraid|esxi|vmware|synology|nas/.test(f)) return 'server';
  if (/ubuntu|debian|fedora|centos|rhel|arch|manjaro|mint|kali|alpine|opensuse|linux|tails|parrot/.test(f)) return 'linux';
  if (/tool|util|clonezilla|gparted|hirens|system/.test(f)) return 'tool';
  return 'disc';
}

// Détecte le format depuis l'extension
function detectFormat(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  const known = ['iso','img','vmdk','qcow2','vdi','raw','vhd','vhdx'];
  return known.includes(ext) ? ext : null;
}

// Détecte l'édition depuis un nom de fichier
function detectEdition(filename) {
  const f = filename.toLowerCase();
  if (/server|srv|datacenter/.test(f))          return 'server';
  if (/workstation/.test(f))                     return 'workstation';
  if (/-cli|-minimal|minimal|netinstall|net-install|netboot/.test(f)) return 'cli';
  if (/live/.test(f))                            return 'live';
  if (/core/.test(f))                            return 'core';
  if (/desktop|gnome|kde|xfce|lxde|mate|cinnamon|plasma/.test(f)) return 'desktop';
  return null;
}

// Détecte catégorie + os_family depuis un nom de fichier
function detectOSInfo(filename) {
  const f = filename.toLowerCase();
  if (/windows|win(10|11|server|xp|vista|7|8)/.test(f))
    return { category: 'windows', os_family: 'windows' };
  if (/ubuntu/.test(f))    return { category: 'linux', os_family: 'ubuntu' };
  if (/debian/.test(f))    return { category: 'linux', os_family: 'debian' };
  if (/fedora/.test(f))    return { category: 'linux', os_family: 'fedora' };
  if (/centos/.test(f))    return { category: 'linux', os_family: 'centos' };
  if (/kali/.test(f))      return { category: 'linux', os_family: 'kali' };
  if (/arch/.test(f))      return { category: 'linux', os_family: 'arch' };
  if (/mint/.test(f))      return { category: 'linux', os_family: 'mint' };
  if (/manjaro/.test(f))   return { category: 'linux', os_family: 'manjaro' };
  if (/alpine/.test(f))    return { category: 'linux', os_family: 'alpine' };
  if (/freebsd/.test(f))   return { category: 'linux', os_family: 'freebsd' };
  if (/truenas/.test(f))   return { category: 'linux', os_family: 'truenas' };
  if (/proxmox/.test(f))   return { category: 'linux', os_family: 'proxmox' };
  if (/unraid/.test(f))    return { category: 'linux', os_family: 'unraid' };
  if (/opensuse|suse/.test(f)) return { category: 'linux', os_family: 'opensuse' };
  if (/linux/.test(f))     return { category: 'linux', os_family: 'linux' };
  return { category: 'other', os_family: null };
}

function editionLabel(e) {
  const L = { desktop:'Desktop', server:'Server', cli:'CLI / Minimal', live:'Live',
              netinstall:'Net Install', core:'Core', workstation:'Workstation' };
  return L[e] || e;
}

function btnLoading(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle('loading', on);
}

// ── VIEW ──────────────────────────────────────────────────────────

function setView(v) {
  currentView = v;
  document.getElementById('btnGrid').classList.toggle('active', v === 'grid');
  document.getElementById('btnList').classList.toggle('active', v === 'list');
  renderData();
}

// ── FILTERS ───────────────────────────────────────────────────────

function applyFilters() {
  currentFilters = {
    category: document.getElementById('filterCategory').value,
    os:       document.getElementById('filterOS').value,
    arch:     document.getElementById('filterArch').value,
    edition:  document.getElementById('filterEdition').value,
    q:        document.getElementById('filterSearch').value,
  };
  currentPage = 1;
  loadISOs();
}

// ── LOAD ──────────────────────────────────────────────────────────

async function loadISOs() {
  const p = new URLSearchParams();
  if (currentFilters.category) p.set('category', currentFilters.category);
  if (currentFilters.os)       p.set('os', currentFilters.os);
  if (currentFilters.arch)     p.set('arch', currentFilters.arch);
  if (currentFilters.edition)  p.set('edition', currentFilters.edition);
  if (currentFilters.q)        p.set('q', currentFilters.q);
  if (filterFavorites)         p.set('favorites', 'true');
  p.set('page', currentPage);
  const perPage = document.getElementById('perPageSelect')?.value || 24;
  p.set('per_page', perPage);
  try {
    const d = await fetch(`/api/isos?${p}`).then(r => r.json());
    cachedISOs = d.items;
    cachedPages = d.pages;
    currentPage = d.page;
    renderData();
    renderPagination(d.page, d.pages);
    const active = d.items.some(i => ['downloading','uploading','verifying'].includes(i.status));
    active ? startPolling() : stopPolling();
  } catch { showToast('Erreur de chargement', 'error'); }
}

async function loadStats() {
  try {
    const d = await fetch('/api/stats').then(r => r.json());
    document.getElementById('statCount').textContent = d.total;
    document.getElementById('statDisk').textContent = d.disk_used_formatted;
  } catch {}
}

// ── SORT & GROUP ──────────────────────────────────────────────────

const STATUS_ORDER = { downloading:0, uploading:1, verifying:2, available:3, missing:4, error:5 };

function sortISOs(items) {
  const arr = [...items];
  switch (currentSort) {
    case 'name_asc':  return arr.sort((a,b) => (a.name||'').localeCompare(b.name||''));
    case 'name_desc': return arr.sort((a,b) => (b.name||'').localeCompare(a.name||''));
    case 'size_asc':  return arr.sort((a,b) => (a.size_bytes||0) - (b.size_bytes||0));
    case 'size_desc': return arr.sort((a,b) => (b.size_bytes||0) - (a.size_bytes||0));
    case 'status':    return arr.sort((a,b) => (STATUS_ORDER[a.status]??9) - (STATUS_ORDER[b.status]??9));
    case 'date_asc':  return arr.sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
    default:          return arr.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
  }
}

const OS_GROUPS = [
  { key:'windows', label:'Windows',              icon:'windows', color:'#3a8be8' },
  { key:'linux',   label:'Linux',                icon:'linux',   color:'#f5a623' },
  { key:'nas',     label:'NAS & Virtualisation', icon:'server',  color:'#8a7fcb' },
  { key:'bsd',     label:'BSD',                  icon:'bsd',     color:'#d94f4f' },
  { key:'tools',   label:'Outils & Utilitaires', icon:'tool',    color:'#4aaa6e' },
  { key:'other',   label:'Autres',               icon:'disc',    color:'var(--txt-3)' },
];

function osGroupKey(iso) {
  const f = (iso.os_family || iso.category || '').toLowerCase();
  if (/windows/.test(f))                                                   return 'windows';
  if (/proxmox|truenas|unraid|esxi|vmware|synology|nas|xcp/.test(f))       return 'nas';
  if (/freebsd|openbsd|netbsd/.test(f))                                    return 'bsd';
  if (/tool|util|clonezilla|gparted|hirens/.test(f))                       return 'tools';
  if (/ubuntu|debian|fedora|centos|rhel|arch|manjaro|mint|kali|alpine|opensuse|linux|tails|parrot|rocky|alma/.test(f)) return 'linux';
  if (iso.category === 'windows') return 'windows';
  if (iso.category === 'linux')   return 'linux';
  if (iso.category === 'tools')   return 'tools';
  return 'other';
}

function toggleGroupBy() {
  currentGroupBy = currentGroupBy ? false : 'os';
  document.getElementById('btnGroup').classList.toggle('active', !!currentGroupBy);
  renderData();
}

// ── RENDER ────────────────────────────────────────────────────────

function renderData() {
  const el = document.getElementById('isoContainer');
  if (!cachedISOs.length) {
    const hasFilters = Object.values(currentFilters).some(Boolean);
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-illustration">
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
            <rect x="8" y="16" width="48" height="36" rx="4" fill="var(--bg-3)" stroke="var(--border-2)" stroke-width="1.5"/>
            <circle cx="32" cy="34" r="10" fill="var(--bg-2)" stroke="var(--border-2)" stroke-width="1.5"/>
            <circle cx="32" cy="34" r="4" fill="var(--border-2)"/>
            <rect x="14" y="20" width="12" height="2" rx="1" fill="var(--border-2)"/>
          </svg>
        </div>
        ${hasFilters
          ? `<h3>Aucun résultat</h3><p>Aucune ISO ne correspond à vos filtres.</p>
             <button class="btn btn-ghost" onclick="clearFilters()">Effacer les filtres</button>`
          : `<h3>Aucune ISO</h3>
             <p>Commencez par ajouter une image depuis une URL, un upload, ou en scannant le dossier de stockage.</p>
             <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:4px">
               <button class="btn btn-primary" onclick="openModal('modalAdd')">${svg('plus',13)} Ajouter une ISO</button>
               <button class="btn btn-secondary" onclick="openModal('modalBrowse');runScan()">${svg('disc',13)} Parcourir le stockage</button>
             </div>`}
      </div>`;
    return;
  }
  const sorted = sortISOs(cachedISOs);

  if (currentGroupBy === 'os') {
    renderGroupedView(el, sorted);
    return;
  }

  if (currentView === 'grid') {
    el.innerHTML = '<div class="iso-grid">' + sorted.map(renderCard).join('') + '</div>';
  } else {
    el.innerHTML =
      '<div class="iso-table-wrap"><table class="iso-list">' +
      '<thead><tr><th></th><th>Nom</th><th>OS</th><th>Version</th>' +
      '<th>Archi</th><th>Taille</th><th>Statut</th><th>Actions</th></tr></thead>' +
      '<tbody>' + sorted.map(renderRow).join('') + '</tbody></table></div>';
  }
}

function renderGroupedView(el, sorted) {
  const map = {};
  sorted.forEach(iso => {
    const k = osGroupKey(iso);
    if (!map[k]) map[k] = [];
    map[k].push(iso);
  });

  const isList = currentView === 'list';
  let html = '';
  for (const g of OS_GROUPS) {
    const items = map[g.key];
    if (!items || !items.length) continue;
    const count = items.length;
    const bodyHtml = isList
      ? '<div class="iso-table-wrap"><table class="iso-list">' +
        '<thead><tr><th></th><th>Nom</th><th>OS</th><th>Version</th><th>Archi</th><th>Taille</th><th>Statut</th><th>Actions</th></tr></thead>' +
        '<tbody>' + items.map(renderRow).join('') + '</tbody></table></div>'
      : '<div class="iso-grid">' + items.map(renderCard).join('') + '</div>';

    html += '<div class="os-group">' +
      '<div class="os-group-header">' +
      '<div class="os-group-icon" style="color:' + g.color + '">' + svg(g.icon, 18) + '</div>' +
      '<span class="os-group-label">' + g.label + '</span>' +
      '<span class="os-group-count">' + count + ' ISO' + (count > 1 ? 's' : '') + '</span>' +
      '<div class="os-group-line"></div>' +
      '</div>' + bodyHtml + '</div>';
  }
  el.innerHTML = html;
}

function renderCard(iso) {
  const active = ['downloading','uploading','verifying'].includes(iso.status);
  const icon = osIcon(iso.os_family);

  const progress = active ? `
    <div class="progress-row">
      <div class="progress-track"><div class="progress-fill" style="width:${iso.download_progress}%"></div></div>
      <span class="progress-pct">${iso.download_progress}%</span>
    </div>` : '';

  // Info rows
  const metaParts = [iso.os_family, iso.version, iso.architecture].filter(Boolean);
  const editionBadge = iso.edition ? `<span class="edition-tag edition-${iso.edition}">${editionLabel(iso.edition)}</span>` : '';
  const formatBadge  = iso.file_format && iso.file_format !== 'iso'
    ? `<span class="format-tag">${iso.file_format.toUpperCase()}</span>` : '';
  const hashRow = iso.sha256
    ? `<div class="card-info-row">
        <span class="card-info-label">${svg('shield',11)} Hash</span>
        <span class="card-info-val hash-chip ${iso.checksum_verified===true?'ok':iso.checksum_verified===false?'bad':''}">
          ${iso.checksum_verified===true?'✓ ':iso.checksum_verified===false?'✗ ':''}${iso.sha256.slice(0,12)}…
        </span>
       </div>` : '';

  const updateBadge = iso.update_available === true
    ? `<span class="badge badge-update" title="Mise à jour disponible">${svg('refresh',10)} Màj dispo</span>` : '';

  let footer = '';
  if (iso.status === 'available') {
    const checkUpdateBtn = iso.source_url
      ? `<button class="card-btn-sec" onclick="event.stopPropagation();checkUpdate(${iso.id})" title="Vérifier si une mise à jour est disponible">${svg('refresh',12)} Màj</button>`
      : '';
    footer = `
      <div class="card-footer">
        <a class="card-btn-primary" href="/files/${encodeURIComponent(iso.filename)}" download onclick="event.stopPropagation()">
          ${svg('download',14)} Télécharger
        </a>
        <div class="card-btn-row">
          <button class="card-btn-sec" onclick="event.stopPropagation();copyURL(${iso.id})">${svg('copy',12)} Copier URL</button>
          <button class="card-btn-sec" onclick="event.stopPropagation();verifyISO(${iso.id})">${svg('shield',12)} Hash</button>
          ${checkUpdateBtn}
          <button class="card-btn-sec" onclick="event.stopPropagation();openEditModal(${iso.id})">${svg('edit',12)} Éditer</button>
          <button class="card-btn-sec danger" onclick="event.stopPropagation();confirmDelete(${iso.id},'${esc(iso.name)}')">${svg('trash',12)}</button>
        </div>
      </div>`;
  } else if (iso.status === 'missing') {
    footer = `
      <div class="card-footer">
        <div class="card-missing-msg">${svg('alert',13)} Fichier introuvable sur le disque</div>
        <div class="card-btn-row">
          <button class="card-btn-sec" onclick="openEditModal(${iso.id})">${svg('edit',12)} Éditer</button>
          <button class="card-btn-sec danger" onclick="confirmDelete(${iso.id},'${esc(iso.name)}')">${svg('trash',12)} Supprimer</button>
        </div>
      </div>`;
  } else if (iso.status === 'error') {
    footer = `
      <div class="card-footer">
        <div class="card-btn-row">
          <button class="card-btn-sec danger" onclick="confirmDelete(${iso.id},'${esc(iso.name)}')">${svg('trash',12)} Supprimer</button>
        </div>
      </div>`;
  }

  const starIcon = iso.is_favorite
    ? '<svg width="13" height="13" style="color:#f5c842"><use href="#ic-star-filled"/></svg>'
    : '<svg width="13" height="13"><use href="#ic-star"/></svg>';

  const isSelected = selectedIds.has(iso.id);
  const cardClick = selectMode
    ? `toggleCardSelect(${iso.id}, event)`
    : `openDrawer(${iso.id})`;

  // En mode sélection, la card-icon devient une checkbox visuelle
  const cardIconHtml = selectMode
    ? `<div class="card-icon card-icon-checkbox${isSelected ? ' checked' : ''}" onclick="toggleCardSelect(${iso.id},event)">
        ${isSelected
          ? `<svg width="20" height="20" style="color:#fff"><use href="#ic-check"/></svg>`
          : `<svg width="18" height="18" style="color:var(--txt-3)"><use href="#ic-check-sq"/></svg>`}
       </div>`
    : `<div class="card-icon">${svg(icon, 26)}</div>`;

  return `
  <div class="iso-card${isSelected ? ' selected' : ''}" id="card-${iso.id}" onclick="${cardClick}" style="cursor:pointer">
    <div class="card-top">
      ${cardIconHtml}
      <div class="card-top-info">
        <div class="card-name">${esc(iso.name)}</div>
        <div class="card-sub">${metaParts.map(m=>`<span class="card-tag">${esc(m)}</span>`).join('')}${editionBadge}${formatBadge}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <button class="star-btn${iso.is_favorite ? ' active' : ''}" data-id="${iso.id}"
          onclick="toggleFavorite(${iso.id},event)"
          title="${iso.is_favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${starIcon}</button>
        ${updateBadge}
        ${renderBadge(iso.status)}
      </div>
    </div>
    <div class="card-body">
      <div class="card-info-row">
        <span class="card-info-label">${svg('disc',11)} Taille</span>
        <span class="card-info-val">${fmtSize(iso.size_bytes)}</span>
      </div>
      ${iso.category ? `<div class="card-info-row">
        <span class="card-info-label">${svg('grid',11)} Catégorie</span>
        <span class="card-info-val">${esc(iso.category)}</span>
      </div>` : ''}
      ${hashRow}
      ${progress}
    </div>
    ${footer}
  </div>`;
}

function renderRow(iso) {
  const active = ['downloading','uploading','verifying'].includes(iso.status);
  const icon = osIcon(iso.os_family);

  const ab = 'display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:5px 9px;border-radius:5px;border:1px solid var(--border-2);background:var(--bg-3);color:var(--txt-2);font-size:11px;cursor:pointer;text-decoration:none;';
  const checkUpdateRowBtn = iso.source_url
    ? `<button style="${ab}" onclick="checkUpdate(${iso.id})" title="Vérifier MAJ">${svg('refresh',12)}</button>`
    : '';
  const actions = iso.status === 'available' ? `
    <button style="${ab}" onclick="copyURL(${iso.id})" title="Copier URL">${svg('copy',12)}</button>
    <a style="${ab}" href="/files/${encodeURIComponent(iso.filename)}" download title="Télécharger">${svg('download',12)}</a>
    <button style="${ab}" onclick="verifyISO(${iso.id})" title="Hash">${svg('shield',12)}</button>
    ${checkUpdateRowBtn}
    <button style="${ab}" onclick="openEditModal(${iso.id})" title="Éditer">${svg('edit',12)}</button>
    <button style="${ab}border-color:rgba(224,82,82,0.4);color:#c07070;" onclick="confirmDelete(${iso.id},'${esc(iso.name)}')" title="Supprimer">${svg('trash',12)}</button>
  ` : `<button style="${ab}border-color:rgba(224,82,82,0.4);color:#c07070;" onclick="confirmDelete(${iso.id},'${esc(iso.name)}')" title="Supprimer">${svg('trash',12)}</button>`;

  const prog = active ? `
    <div class="progress-row" style="margin-top:4px">
      <div class="progress-track"><div class="progress-fill" style="width:${iso.download_progress}%"></div></div>
      <span class="progress-pct">${iso.download_progress}%</span>
    </div>` : '';

  return `
  <tr id="row-${iso.id}">
    <td><div class="list-icon">${svg(icon, 15)}</div></td>
    <td>
      <div style="font-weight:600;font-size:13px">${esc(iso.name)}</div>
      <div style="font-size:11px;color:var(--txt-3);margin-top:1px">${esc(iso.filename)}</div>
    </td>
    <td style="color:var(--txt-2);font-size:12px">${esc(iso.os_family||'—')}</td>
    <td style="color:var(--txt-2);font-size:12px">${esc(iso.version||'—')}</td>
    <td style="color:var(--txt-2);font-size:12px">${esc(iso.architecture||'—')}</td>
    <td style="font-variant-numeric:tabular-nums;color:var(--txt-2);font-size:12px">${fmtSize(iso.size_bytes)}</td>
    <td>${renderBadge(iso.status)}${prog}</td>
    <td><div style="display:flex;gap:4px;align-items:center">${actions}</div></td>
  </tr>`;
}

function renderBadge(s) {
  const L = { available:'Disponible', downloading:'Téléchargement', uploading:'Upload', verifying:'Vérification', error:'Erreur', missing:'Fichier manquant' };
  return `<span class="badge badge-${s}"><span class="badge-dot"></span>${L[s]||s}</span>`;
}

// ── PAGINATION ────────────────────────────────────────────────────

function renderPagination(page, pages) {
  const el = document.getElementById('pagination');
  if (pages <= 1) { el.innerHTML = ''; return; }
  let h = `<button class="page-btn" onclick="goPage(${page-1})" ${page<=1?'disabled':''}>←</button>`;
  for (let i = 1; i <= pages; i++) {
    if (i===1||i===pages||(i>=page-2&&i<=page+2))
      h += `<button class="page-btn ${i===page?'active':''}" onclick="goPage(${i})">${i}</button>`;
    else if (i===page-3||i===page+3)
      h += `<span style="color:var(--txt-3);padding:0 4px">…</span>`;
  }
  h += `<button class="page-btn" onclick="goPage(${page+1})" ${page>=pages?'disabled':''}>→</button>`;
  el.innerHTML = h;
}

function goPage(p) {
  if (p < 1 || p > cachedPages) return;
  currentPage = p;
  loadISOs();
}

// ── POLLING ───────────────────────────────────────────────────────

function startPolling() {
  if (pollingInterval) return;
  pollingInterval = setInterval(async () => {
    try {
      const active = await fetch('/api/downloads/active').then(r => r.json());
      if (!active.length) { stopPolling(); loadISOs(); loadStats(); return; }
      active.forEach(item => {
        ['card','row'].forEach(pfx => {
          const el = document.getElementById(`${pfx}-${item.id}`);
          if (!el) return;
          const fill = el.querySelector('.progress-fill');
          const pct  = el.querySelector('.progress-pct');
          if (fill) fill.style.width = `${item.download_progress}%`;
          if (pct)  pct.textContent  = `${item.download_progress}%`;
        });
      });
    } catch {}
  }, 1000);
}

function stopPolling() {
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
}

// ── MODALS ────────────────────────────────────────────────────────

function openModal(id)  { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
function closeAllModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
}

// ── SCAN ──────────────────────────────────────────────────────────

let scanFiles = [];

function detectCategory(filename) {
  return detectOSInfo(filename).category;
}

const SCAN_GROUPS = [
  { key: 'linux',   label: 'Linux & Unix', icon: 'linux',   color: 'var(--green)'  },
  { key: 'windows', label: 'Windows',      icon: 'windows', color: 'var(--blue)'   },
  { key: 'other',   label: 'Autres',       icon: 'disc',    color: 'var(--txt-2)'  },
];

async function runScan() {
  const list = document.getElementById('scanList');
  const countEl = document.getElementById('scanCount');
  document.getElementById('btnImport').disabled = true;
  document.getElementById('scanSelBar').textContent = '';
  countEl.style.display = 'none';
  list.innerHTML = `<div class="scan-loading"><div class="spin-sm"></div> Scan en cours…</div>`;

  try {
    const data = await fetch('/api/browse').then(r => r.json());
    scanFiles = data.files || [];

    document.getElementById('scanTracked').textContent = data.total - data.untracked;
    document.getElementById('scanNew').textContent = data.untracked;
    countEl.style.display = scanFiles.length ? 'flex' : 'none';
    const btnSelNew = document.getElementById('btnSelectAllNew');
    if (btnSelNew) btnSelNew.style.display = data.untracked > 0 ? '' : 'none';

    if (!scanFiles.length) {
      list.innerHTML = `<div class="scan-empty">${svg('disc',28)}<br><br>Aucun fichier compatible trouvé dans le stockage</div>`;
      return;
    }

    // Grouper par catégorie détectée
    const groups = {};
    scanFiles.forEach((f, i) => {
      const cat = detectCategory(f.filename);
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push({ ...f, _idx: i });
    });

    let html = '';
    for (const g of SCAN_GROUPS) {
      const items = groups[g.key];
      if (!items?.length) continue;

      const newCount = items.filter(f => !f.tracked).length;
      const newIdxList = items.filter(f => !f.tracked).map(f => f._idx).join(',');
      html += `
        <div class="scan-group">
          <div class="scan-group-header">
            <div class="scan-group-icon" style="color:${g.color}">${svg(g.icon, 14)}</div>
            <span class="scan-group-label">${g.label}</span>
            <span class="scan-group-count">${items.length} fichier${items.length>1?'s':''}</span>
            ${newCount > 0 ? `<span class="scan-group-new">${newCount} nouveau${newCount>1?'x':''}</span>` : ''}
            ${newCount > 0 ? `<button class="scan-select-new-btn" onclick="selectNewInGroup([${newIdxList}])" title="Sélectionner tous les nouveaux">Tout sélectionner</button>` : ''}
          </div>
          ${items.map(f => {
            const tracked = f.tracked;
            const osInfo = detectOSInfo(f.filename);
            const icon = osIcon(osInfo.os_family);
            return `
            <div class="scan-item ${tracked ? 'tracked' : 'untracked'}" id="si-${f._idx}"
              ${!tracked ? `onclick="toggleScanItem(${f._idx})"` : ''}>
              ${!tracked
                ? `<input type="checkbox" id="sc-${f._idx}" onclick="event.stopPropagation();toggleScanItem(${f._idx})">`
                : `<div class="scan-item-check">${svg('check',13)}</div>`
              }
              <div class="scan-item-icon">${svg(icon, 14)}</div>
              <div class="scan-item-info">
                <span class="scan-filename">${esc(f.filename)}</span>
                <span class="scan-ext-label">${esc(f.extension.replace('.','').toUpperCase())}</span>
              </div>
              <span class="scan-size">${fmtSize(f.size_bytes)}</span>
              <span class="scan-status ${tracked ? 'ok' : 'new'}">${tracked ? 'Indexé' : 'Nouveau'}</span>
            </div>`;
          }).join('')}
        </div>`;
    }
    list.innerHTML = html;

  } catch {
    list.innerHTML = `<div class="scan-empty">Erreur lors du scan</div>`;
  }
}

function toggleScanItem(idx) {
  const el = document.getElementById(`si-${idx}`);
  const cb = document.getElementById(`sc-${idx}`);
  if (!el) return;
  const now = !el.classList.contains('selected');
  el.classList.toggle('selected', now);
  if (cb) cb.checked = now;
  updateScanSelection();
}

function updateScanSelection() {
  const selectedEls = [...document.querySelectorAll('.scan-item.selected')];
  const count = selectedEls.length;
  const bar = document.getElementById('scanSelBar');
  const btn = document.getElementById('btnImport');

  if (count > 0) {
    // Calculate total size of selection
    const totalBytes = selectedEls.reduce((acc, el) => {
      const idx = parseInt(el.id.replace('si-', ''));
      return acc + (scanFiles[idx]?.size_bytes || 0);
    }, 0);
    bar.textContent = `${count} fichier${count>1?'s':''} sélectionné${count>1?'s':''} · ${fmtSize(totalBytes)}`;
    bar.className = 'scan-selection-bar has-selection';
  } else {
    bar.textContent = 'Cochez les fichiers à importer (les déjà indexés sont grisés)';
    bar.className = 'scan-selection-bar';
  }
  btn.disabled = count === 0;
}

function selectAllNew() {
  scanFiles.forEach((f, idx) => {
    if (f.tracked) return;
    const el = document.getElementById(`si-${idx}`);
    const cb = document.getElementById(`sc-${idx}`);
    if (!el) return;
    el.classList.add('selected');
    if (cb) cb.checked = true;
  });
  updateScanSelection();
}

function selectNewInGroup(indices) {
  indices.forEach(idx => {
    const el = document.getElementById(`si-${idx}`);
    const cb = document.getElementById(`sc-${idx}`);
    if (!el || el.classList.contains('tracked')) return;
    el.classList.add('selected');
    if (cb) cb.checked = true;
  });
  updateScanSelection();
}

async function importSelected() {
  const selectedEls = [...document.querySelectorAll('.scan-item.selected')];
  if (!selectedEls.length) return;

  const btn = document.getElementById('btnImport');
  btnLoading(btn, true);

  let ok = 0, fail = 0;
  for (const el of selectedEls) {
    const idx = parseInt(el.id.replace('si-',''));
    const file = scanFiles[idx];
    if (!file) continue;
    try {
      const osInfo = detectOSInfo(file.filename);
      const res = await fetch('/api/isos/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename:    file.filename,
          category:    osInfo.category,
          os_family:   osInfo.os_family,
          edition:     detectEdition(file.filename),
          file_format: detectFormat(file.filename),
        }),
      });
      if (!res.ok) throw new Error();
      ok++;
    } catch { fail++; }
  }

  btnLoading(btn, false);
  closeAllModals();
  loadISOs(); loadStats(); startPolling();
  if (ok)   showToast(`${ok} fichier(s) importé(s) — calcul SHA256 en cours…`, 'success');
  if (fail) showToast(`${fail} importation(s) échouée(s)`, 'error');
}

// ── ADD FROM URL ──────────────────────────────────────────────────

async function submitFromURL(e) {
  e.preventDefault();
  const form = e.target;
  const btn  = form.querySelector('[type="submit"]');
  if (!form.url.value.trim()) { showToast('URL requise', 'error'); return; }

  if (!form.name.value.trim()) { showToast('Le nom affiché est obligatoire', 'error'); form.name.focus(); return; }
  btnLoading(btn, true);
  try {
    const res = await fetch('/api/isos/from-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url:               form.url.value.trim(),
        name:              form.name.value.trim(),
        category:          form.category.value,
        os_family:         form.os_family.value.trim() || null,
        version:           form.version.value.trim() || null,
        architecture:      form.architecture.value,
        expected_checksum: form.expected_checksum.value.trim() || null,
        checksum_type:     form.checksum_type.value,
        description:       form.description.value.trim() || null,
        tags:              form.tags.value.trim() || null,
      }),
    });
    if (!res.ok) throw new Error((await res.json()).detail);
    showToast('Téléchargement démarré !', 'success');
    closeAllModals();
    form.reset();
    loadISOs(); loadStats(); startPolling();
  } catch (err) { showToast(`Erreur : ${err.message}`, 'error'); }
  finally { btnLoading(btn, false); }
}

// ── UPLOAD ────────────────────────────────────────────────────────

let selectedFile = null;

function handleFileSelected(file) {
  selectedFile = file;
  document.getElementById('fileSelected').classList.add('visible');
  document.getElementById('fileSelectedName').textContent = `${file.name} · ${fmtSize(file.size)}`;
  const n = document.getElementById('uploadName');
  if (!n.value) n.value = file.name.replace(/\.[^.]+$/, '');
}

async function submitUpload(e) {
  e.preventDefault();
  if (!selectedFile) { showToast('Aucun fichier sélectionné', 'error'); return; }
  const form = e.target;
  const btn  = form.querySelector('[type="submit"]');
  if (!form.name.value.trim()) { showToast('Le nom affiché est obligatoire', 'error'); form.name.focus(); return; }
  btnLoading(btn, true);

  const fd = new FormData();
  fd.append('file', selectedFile);
  ['name','category','os_family','version','architecture','description','tags'].forEach(f => {
    const v = form[f]?.value?.trim();
    if (v) fd.append(f, v);
  });

  const wrap = document.getElementById('uploadProgressWrap');
  const bar  = document.getElementById('uploadProgressBar');
  const pct  = document.getElementById('uploadProgressPct');
  wrap.style.display = 'block';

  await new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener('progress', e => {
      if (!e.lengthComputable) return;
      const p = Math.round(e.loaded / e.total * 100);
      bar.style.width = `${p}%`;
      pct.textContent = `${p}%`;
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        showToast('Fichier uploadé !', 'success');
        closeAllModals();
        form.reset(); selectedFile = null;
        document.getElementById('fileSelected').classList.remove('visible');
        wrap.style.display = 'none';
        bar.style.width = '0%';
        loadISOs(); loadStats();
      } else {
        try { showToast(JSON.parse(xhr.responseText).detail, 'error'); }
        catch { showToast('Erreur upload', 'error'); }
      }
      btnLoading(btn, false); resolve();
    });
    xhr.addEventListener('error', () => { showToast('Erreur réseau', 'error'); btnLoading(btn, false); resolve(); });
    xhr.open('POST', '/api/isos/upload');
    xhr.send(fd);
  });
}

// ── EDIT ──────────────────────────────────────────────────────────

let editingId = null;

function openEditModal(id) {
  const iso = cachedISOs.find(i => i.id === id);
  if (!iso) return;
  editingId = id;
  const f = document.getElementById('formEdit');
  f.editName.value             = iso.name || '';
  f.editCategory.value         = iso.category || 'other';
  f.editOsFamily.value         = iso.os_family || '';
  f.editVersion.value          = iso.version || '';
  f.editArchitecture.value     = iso.architecture || 'x86_64';
  f.editDescription.value      = iso.description || '';
  f.editTags.value             = iso.tags || '';
  f.editExpectedChecksum.value = iso.expected_checksum || '';
  f.editChecksumType.value     = iso.checksum_type || 'sha256';
  f.editEdition.value          = iso.edition || '';
  f.editFileFormat.value       = iso.file_format || '';

  // Hash info section
  const noHashEl   = document.getElementById('editHashNoHash');
  const dataRows   = document.querySelectorAll('#editHashInfo .hash-row-data');
  if (iso.sha256) {
    noHashEl.classList.add('hidden');
    dataRows.forEach(r => r.classList.remove('hidden'));
    document.getElementById('editHashSHA256').textContent = iso.sha256;
    const statusEl = document.getElementById('editHashStatus');
    if (iso.checksum_verified === true)       { statusEl.textContent = '✓ Vérifié'; statusEl.className = 'hash-status ok'; }
    else if (iso.checksum_verified === false) { statusEl.textContent = '✗ Invalide'; statusEl.className = 'hash-status bad'; }
    else                                      { statusEl.textContent = 'Calculé (non comparé)'; statusEl.className = 'hash-status neutral'; }
    document.getElementById('editHashSize').textContent = iso.size_bytes ? fmtSize(iso.size_bytes) : '—';
    const srcEl = document.getElementById('editHashSource');
    srcEl.textContent = iso.source_url || '(upload / import local)';
    document.getElementById('editHashSourceRow').classList.toggle('hidden', !iso.source_url);
  } else {
    noHashEl.classList.remove('hidden');
    dataRows.forEach(r => r.classList.add('hidden'));
  }

  openModal('modalEdit');
}

function copyHashValue(elId) {
  const val = document.getElementById(elId)?.textContent;
  if (!val || val === '—') return;
  navigator.clipboard.writeText(val).then(() => showToast('Hash copié', 'success'))
    .catch(() => showToast('Impossible de copier', 'error'));
}

async function submitEdit(e) {
  e.preventDefault();
  if (!editingId) return;
  const form = e.target;
  const btn  = form.querySelector('[type="submit"]');
  btnLoading(btn, true);
  try {
    const res = await fetch(`/api/isos/${editingId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:              form.editName.value.trim(),
        category:          form.editCategory.value,
        os_family:         form.editOsFamily.value.trim() || null,
        version:           form.editVersion.value.trim() || null,
        architecture:      form.editArchitecture.value,
        description:       form.editDescription.value.trim() || null,
        tags:              form.editTags.value.trim() || null,
        expected_checksum: form.editExpectedChecksum.value.trim() || null,
        checksum_type:     form.editChecksumType.value,
        edition:           form.editEdition.value || null,
        file_format:       form.editFileFormat.value || null,
      }),
    });
    if (!res.ok) throw new Error((await res.json()).detail);
    showToast('Métadonnées mises à jour', 'success');
    closeAllModals(); loadISOs();
  } catch (err) { showToast(`Erreur : ${err.message}`, 'error'); }
  finally { btnLoading(btn, false); }
}

// ── DELETE ────────────────────────────────────────────────────────

let deleteId = null;

function confirmDelete(id, name) {
  deleteId = id;
  document.getElementById('confirmMsg').textContent =
    `Supprimer "${name}" ? Le fichier sera effacé du disque et de la base de données.`;
  openModal('modalConfirm');
}

async function executeDelete() {
  if (!deleteId) return;
  const btn = document.querySelector('#modalConfirm .btn-primary');
  btnLoading(btn, true);
  try {
    const res = await fetch(`/api/isos/${deleteId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).detail);
    showToast('ISO supprimée', 'success');
    closeAllModals(); loadISOs(); loadStats();
  } catch (err) { showToast(`Erreur : ${err.message}`, 'error'); }
  finally { btnLoading(btn, false); deleteId = null; }
}

// ── VERIFY ────────────────────────────────────────────────────────

async function verifyISO(id) {
  // Lancer le polling immédiatement pour montrer "Vérification" sur la carte
  startPolling();
  try {
    const res = await fetch(`/api/isos/${id}/verify`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).detail);
    const iso = await res.json();
    showToast(
      iso.checksum_verified === true  ? '✓ Hash vérifié avec succès' :
      iso.checksum_verified === false ? '✗ Hash invalide !' : 'SHA256 calculé',
      iso.checksum_verified === true ? 'success' : iso.checksum_verified === false ? 'error' : 'info'
    );
    await loadISOs();
    // If edit modal is open for this ISO, refresh it
    if (editingId === id && !document.getElementById('modalEdit').classList.contains('hidden')) {
      openEditModal(id);
    }
  } catch (err) { showToast(`Erreur : ${err.message}`, 'error'); }
}

// ── CHECK UPDATE ──────────────────────────────────────────────────

async function checkUpdate(id) {
  // Feedback visuel immédiat sur tous les boutons de cet ISO
  document.querySelectorAll(`[id*="CheckUpdateBtn-${id}"], .card-btn-sec`).forEach(b => {
    if (b.textContent.includes('Màj') || b.textContent.includes('MAJ')) b.disabled = true;
  });
  showToast('Vérification en cours…', 'info');
  try {
    const res = await fetch(`/api/isos/${id}/check-update`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).detail);
    const iso = await res.json();
    const idx = cachedISOs.findIndex(i => i.id === id);
    if (idx !== -1) cachedISOs[idx] = iso;

    if (iso.update_available === true) {
      showToast('⚠ Mise à jour disponible pour cette ISO !', 'error');
    } else if (iso.update_available === false) {
      showToast('✓ ISO à jour', 'success');
    } else {
      showToast('Impossible de déterminer — pas de fichier checksum trouvé', 'info');
    }
    await loadISOs();
  } catch (err) {
    showToast(`Erreur : ${err.message}`, 'error');
  }
}

// ── COPY URL ──────────────────────────────────────────────────────

async function copyURL(id) {
  const iso = cachedISOs.find(i => i.id === id);
  if (!iso?.http_url) return;
  try {
    await navigator.clipboard.writeText(iso.http_url);
    showToast('URL copiée dans le presse-papier', 'success');
  } catch { showToast('Impossible de copier', 'error'); }
}

// ── FAVORITES ─────────────────────────────────────────────────────

function toggleFavFilter() {
  filterFavorites = !filterFavorites;
  const btn = document.getElementById('btnFavFilter');
  btn.classList.toggle('active', filterFavorites);
  currentPage = 1;
  loadISOs();
}

async function toggleFavorite(id, e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  try {
    const res = await fetch('/api/isos/' + id + '/favorite', { method: 'POST' });
    if (!res.ok) throw new Error();
    const iso = await res.json();
    // Update cache
    const idx = cachedISOs.findIndex(i => i.id === id);
    if (idx !== -1) cachedISOs[idx] = iso;
    // Update star button(s) in DOM without full re-render
    document.querySelectorAll('.star-btn[data-id="' + id + '"]').forEach(btn => {
      btn.classList.toggle('active', !!iso.is_favorite);
      btn.title = iso.is_favorite ? 'Retirer des favoris' : 'Ajouter aux favoris';
      btn.innerHTML = iso.is_favorite
        ? '<svg width="13" height="13" style="color:#f5c842"><use href="#ic-star-filled"/></svg>'
        : '<svg width="13" height="13"><use href="#ic-star"/></svg>';
    });
    showToast(iso.is_favorite ? '⭐ Ajouté aux favoris' : 'Retiré des favoris', 'info');
    if (filterFavorites) loadISOs();
  } catch { showToast('Erreur', 'error'); }
}

// ── CLEAR FILTERS ─────────────────────────────────────────────────

function clearFilters() {
  document.getElementById('filterSearch').value = '';
  document.getElementById('filterCategory').value = '';
  document.getElementById('filterOS').value = '';
  document.getElementById('filterArch').value = '';
  document.getElementById('filterEdition').value = '';
  filterFavorites = false;
  document.getElementById('btnFavFilter')?.classList.remove('active');
  currentFilters = {};
  currentPage = 1;
  loadISOs();
}

// ── DRAWER APERÇU ─────────────────────────────────────────────────

function openDrawer(id) {
  const iso = cachedISOs.find(i => i.id === id);
  if (!iso) return;

  document.getElementById('drawerTitle').textContent = iso.name;

  const statusLabel = { available:'Disponible', downloading:'Téléchargement', uploading:'Upload',
    verifying:'Vérification', error:'Erreur', missing:'Fichier manquant' };

  const rows = [
    ['Fichier',     iso.filename || '—'],
    ['Taille',      fmtSize(iso.size_bytes)],
    ['Catégorie',   iso.category || '—'],
    ['OS Family',   iso.os_family || '—'],
    ['Version',     iso.version || '—'],
    ['Architecture',iso.architecture || '—'],
    ['Statut',      statusLabel[iso.status] || iso.status],
    ['Ajout',       iso.add_method || '—'],
    ['Source URL',  iso.source_url ? `<a href="${esc(iso.source_url)}" target="_blank" style="color:var(--orange);word-break:break-all">${esc(iso.source_url)}</a>` : '—'],
    ['SHA256',      iso.sha256 ? `<span style="display:flex;align-items:flex-start;gap:6px"><span style="font-family:monospace;font-size:11px;word-break:break-all;flex:1">${esc(iso.sha256)}</span><button onclick="navigator.clipboard.writeText('${iso.sha256}').then(()=>showToast('SHA256 copié','success'))" style="flex-shrink:0;padding:2px 6px;border:1px solid var(--border-2);background:var(--bg-3);border-radius:4px;color:var(--txt-3);cursor:pointer;font-size:10px">Copier</button></span>` : '<em style="color:var(--txt-3)">Non calculé — cliquez sur Calculer Hash</em>'],
    ['Hash vérifié',iso.checksum_verified === true ? '✓ Oui' : iso.checksum_verified === false ? '✗ Non' : '—'],
    ['Checksum attendu', iso.expected_checksum ? `<span style="font-family:monospace;font-size:10px">${esc(iso.expected_checksum)}</span>` : '—'],
    ['Mise à jour', iso.update_available === true ? '<span style="color:var(--orange);font-weight:600">⚠ Disponible</span>' : iso.update_available === false ? '<span style="color:var(--green)">✓ À jour</span>' : iso.last_update_check ? '— (vérifiez)' : '— (jamais vérifié)'],
    ['Dernier check', iso.last_update_check ? new Date(iso.last_update_check).toLocaleString('fr-FR') : '—'],
    ['SHA256 upstream', iso.upstream_sha256 ? `<span style="font-family:monospace;font-size:10px">${esc(iso.upstream_sha256.slice(0,16))}…</span>` : '—'],
    ['Créé le',     iso.created_at ? new Date(iso.created_at).toLocaleString('fr-FR') : '—'],
    ['Modifié le',  iso.updated_at ? new Date(iso.updated_at).toLocaleString('fr-FR') : '—'],
  ].filter(([,v]) => v && v !== '—');

  const icon = osIcon(iso.os_family);

  document.getElementById('drawerBody').innerHTML = `
    <div class="drawer-icon-row">
      <div class="drawer-os-icon">${svg(icon, 36)}</div>
      ${renderBadge(iso.status)}
    </div>
    <table class="drawer-table">
      ${rows.map(([k,v]) => `<tr><td class="drawer-key">${k}</td><td class="drawer-val">${v}</td></tr>`).join('')}
    </table>
    ${iso.description ? `<div class="drawer-desc"><strong>Description</strong><p>${esc(iso.description)}</p></div>` : ''}
    ${iso.tags ? `<div class="drawer-tags">${iso.tags.split(',').map(t=>`<span class="card-tag">${esc(t.trim())}</span>`).join('')}</div>` : ''}
    <div class="drawer-actions">
      <button class="btn ${iso.is_favorite ? 'btn-fav-active' : 'btn-secondary'} star-btn" data-id="${iso.id}"
        onclick="toggleFavorite(${iso.id},event)">
        ${iso.is_favorite
          ? '<svg width="13" height="13" style="color:#f5c842"><use href="#ic-star-filled"/></svg> Favori'
          : svg('star',13) + ' Épingler'}
      </button>
      ${iso.status==='available' ? `
        <a class="btn btn-primary" href="/files/${encodeURIComponent(iso.filename)}" download style="text-decoration:none">${svg('download',13)} Télécharger</a>
        <button class="btn btn-secondary" onclick="copyURL(${iso.id})">${svg('copy',13)} Copier URL</button>
        <button class="btn btn-secondary" onclick="closeDrawer();verifyISO(${iso.id})">${svg('shield',13)} Calculer Hash</button>
        ${iso.source_url ? `<button class="btn btn-secondary${iso.update_available===true?' btn-update-alert':''}" id="drawerCheckUpdateBtn-${iso.id}" onclick="checkUpdate(${iso.id})">${svg('refresh',13)} Vérifier MAJ</button>` : ''}
        <button class="btn btn-secondary" onclick="closeDrawer();openEditModal(${iso.id})">${svg('edit',13)} Éditer</button>
      ` : ''}
      <button class="btn btn-ghost" onclick="closeDrawer();confirmDelete(${iso.id},'${esc(iso.name)}')" style="color:#c07070">${svg('trash',13)} Supprimer</button>
    </div>`;

  document.getElementById('drawer').classList.remove('hidden');
  document.getElementById('drawerOverlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  document.getElementById('drawer').classList.add('hidden');
  document.getElementById('drawerOverlay').classList.add('hidden');
  document.body.style.overflow = '';
}

// ── DRAG & DROP PAGE PRINCIPALE ───────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('pageDropOverlay');
  let dragActive = false;
  let hideTimer = null;

  const hint = document.getElementById('dropHint');

  function showOverlay() {
    if (!dragActive) { dragActive = true; overlay.classList.remove('hidden'); }
    hint?.classList.add('drag-active');
    clearTimeout(hideTimer);
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      dragActive = false;
      overlay.classList.add('hidden');
      hint?.classList.remove('drag-active');
    }, 80);
  }

  document.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    showOverlay();
  });
  document.addEventListener('dragover', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    showOverlay();
  });
  document.addEventListener('dragleave', e => {
    // Ne cacher que si on quitte réellement la fenêtre
    if (e.relatedTarget === null) scheduleHide();
  });
  document.addEventListener('drop', e => {
    e.preventDefault();
    dragActive = false;
    overlay.classList.add('hidden');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    openModal('modalAdd');
    switchTab('upload');
    handleFileSelected(file);
  });
});

// ── TOAST ─────────────────────────────────────────────────────────

function showToast(msg, type = 'info') {
  const icons = {
    success: `<svg width="14" height="14" style="color:var(--green)"><use href="#ic-check"/></svg>`,
    error:   `<svg width="14" height="14" style="color:var(--red)"><use href="#ic-alert"/></svg>`,
    info:    `<svg width="14" height="14" style="color:var(--orange)"><use href="#ic-disc"/></svg>`,
  };
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `${icons[type]||''}<span>${esc(msg)}</span>`;
  document.getElementById('toastContainer').appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

// ── MULTI-SELECT ───────────────────────────────────────────────────

function toggleSelectMode() {
  selectMode = !selectMode;
  selectedIds.clear();
  document.getElementById('btnSelect').classList.toggle('active', selectMode);
  document.getElementById('selBar').classList.toggle('hidden', !selectMode);
  renderData();
}

function exitSelectMode() {
  selectMode = false;
  selectedIds.clear();
  document.getElementById('btnSelect').classList.remove('active');
  document.getElementById('selBar').classList.add('hidden');
  renderData();
}

function toggleCardSelect(id, e) {
  e.preventDefault();
  e.stopPropagation();
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  // Update this card's checkbox visually
  const card = document.getElementById('card-' + id);
  if (card) card.classList.toggle('selected', selectedIds.has(id));
  updateSelBar();
}

function updateSelBar() {
  const n = selectedIds.size;
  document.getElementById('selBarCount').textContent = n + ' sélectionné' + (n > 1 ? 's' : '');
  ['selBtnHash','selBtnCopy','selBtnExport','selBtnDelete'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = n === 0;
  });
}

function selectAll() {
  cachedISOs.forEach(iso => selectedIds.add(iso.id));
  document.querySelectorAll('.iso-card').forEach(c => c.classList.add('selected'));
  updateSelBar();
}

function selectNone() {
  selectedIds.clear();
  document.querySelectorAll('.iso-card').forEach(c => c.classList.remove('selected'));
  updateSelBar();
}

async function bulkVerify() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const available = cachedISOs.filter(i => ids.includes(i.id) && i.status === 'available');
  if (!available.length) { showToast('Aucun fichier disponible dans la sélection', 'error'); return; }
  showToast('Calcul hash en cours pour ' + available.length + ' fichier(s)…', 'info');
  startPolling();
  let ok = 0;
  for (const iso of available) {
    try {
      await fetch('/api/isos/' + iso.id + '/verify', { method: 'POST' });
      ok++;
    } catch {}
  }
  await loadISOs();
  showToast(ok + ' hash(es) calculé(s)', 'success');
}

async function bulkCopyURLs() {
  const ids = [...selectedIds];
  const urls = cachedISOs
    .filter(i => ids.includes(i.id) && i.http_url)
    .map(i => i.http_url);
  if (!urls.length) { showToast('Aucune URL disponible dans la sélection', 'error'); return; }
  try {
    await navigator.clipboard.writeText(urls.join('\n'));
    showToast(urls.length + ' URL(s) copiée(s)', 'success');
  } catch { showToast('Impossible de copier', 'error'); }
}

function bulkExport() {
  const ids = [...selectedIds];
  const items = cachedISOs.filter(i => ids.includes(i.id));
  if (!items.length) return;
  const rows = [['Nom','Fichier','OS','Version','Archi','Taille','SHA256','URL','Statut']];
  items.forEach(i => rows.push([
    i.name, i.filename, i.os_family||'', i.version||'', i.architecture||'',
    i.size_bytes||0, i.sha256||'', i.http_url||'', i.status
  ]));
  const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'isostack-export.csv';
  a.click();
  showToast(items.length + ' ISO(s) exportée(s) en CSV', 'success');
}

async function bulkDelete() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const names = cachedISOs.filter(i => ids.includes(i.id)).map(i => i.name).join(', ');
  if (!confirm('Supprimer ' + ids.length + ' ISO(s) ?\n\n' + names)) return;
  let ok = 0, fail = 0;
  for (const id of ids) {
    try {
      const res = await fetch('/api/isos/' + id, { method: 'DELETE' });
      if (res.ok) ok++; else fail++;
    } catch { fail++; }
  }
  selectedIds.clear();
  exitSelectMode();
  loadISOs(); loadStats();
  if (ok)   showToast(ok + ' ISO(s) supprimée(s)', 'success');
  if (fail) showToast(fail + ' suppression(s) échouée(s)', 'error');
}

// ── STATS DASHBOARD ────────────────────────────────────────────────

async function openStats() {
  openModal('modalStats');
  const body = document.getElementById('statsModalBody');
  try {
    const [stats, isos] = await Promise.all([
      fetch('/api/stats').then(r => r.json()),
      fetch('/api/isos?per_page=500').then(r => r.json()),
    ]);
    renderStatsModal(body, stats, isos.items || []);
  } catch {
    body.innerHTML = '<p style="color:var(--txt-3);text-align:center">Erreur de chargement</p>';
  }
}

let _statsBarsMode = 'count'; // 'count' | 'size'

function renderStatsModal(body, stats, items) {
  const osColors = { windows:'#3a8be8', linux:'#f5a623', nas:'#8a7fcb', bsd:'#d94f4f', tools:'#4aaa6e', other:'#4a4a5a' };
  const osLabels = { windows:'Windows', linux:'Linux', nas:'NAS & Virt.', bsd:'BSD', tools:'Outils', other:'Autres' };
  const osCounts = {}, osSizes = {};
  items.forEach(iso => {
    const k = osGroupKey(iso);
    osCounts[k] = (osCounts[k] || 0) + 1;
    osSizes[k]  = (osSizes[k]  || 0) + (iso.size_bytes || 0);
  });
  const favCount = items.filter(i => i.is_favorite).length;
  const sortedOS = Object.entries(osCounts).sort((a,b) => b[1]-a[1]);
  const maxOSCount = sortedOS[0]?.[1] || 1;
  const maxOSSize  = Math.max(...Object.values(osSizes)) || 1;

  const statusData = [
    { label:'Téléchargement', val:stats.downloading, color:'var(--orange)', icon:'download' },
    { label:'Upload',         val:stats.uploading,   color:'var(--blue)',   icon:'upload' },
    { label:'Vérification',   val:stats.verifying,   color:'var(--yellow)', icon:'shield' },
    { label:'Erreur',         val:stats.error,       color:'var(--red)',    icon:'alert' },
  ].filter(s => s.val > 0);

  const topItems = [...items].sort((a,b) => (b.size_bytes||0)-(a.size_bytes||0)).slice(0,5);
  const maxTopSize = topItems[0]?.size_bytes || 1;

  const donutSVG = makeDonutSVG(osCounts, osColors, stats.total);

  // Légende donut
  const donutLegend = sortedOS.map(([k]) =>
    '<div class="stats-legend-row">' +
    '<span class="stats-legend-dot" style="background:' + (osColors[k]||'#555') + '"></span>' +
    '<span class="stats-legend-label">' + (osLabels[k]||k) + '</span>' +
    '<span class="stats-legend-val">' + Math.round((osCounts[k]||0) / (stats.total||1) * 100) + '%</span>' +
    '</div>'
  ).join('');

  // Barres OS (réutilisées par le toggle)
  function renderOsBars(mode) {
    const max = mode === 'size' ? maxOSSize : maxOSCount;
    return sortedOS.map(([k,v]) => {
      const raw  = mode === 'size' ? (osSizes[k]||0) : v;
      const pct  = Math.round(raw / max * 100);
      const color = osColors[k] || '#555';
      return '<div class="stats-os-row">' +
        '<div class="stats-os-header">' +
        '<span class="stats-os-dot" style="background:' + color + '"></span>' +
        '<span class="stats-os-name">' + (osLabels[k]||k) + '</span>' +
        '<span class="stats-os-count">' + v + ' ISO' + (v>1?'s':'') + '</span>' +
        '<span class="stats-os-size">' + fmtSize(osSizes[k]||0) + '</span>' +
        '</div>' +
        '<div class="stats-os-track"><div class="stats-os-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
        '</div>';
    }).join('');
  }

  body.innerHTML = '<div class="stats-grid">' +

  // ── KPIs ──
  '<div class="stats-kpis">' +
  [
    { val: stats.total,               label: 'Total ISOs',       color: 'var(--orange)', icon: 'disc' },
    { val: stats.disk_used_formatted, label: 'Stockage utilisé', color: 'var(--blue)',   icon: 'server' },
    { val: stats.available,           label: 'Disponibles',      color: 'var(--green)',  icon: 'check' },
    { val: favCount,                  label: 'Favoris',          color: 'var(--yellow)', icon: 'star' },
  ].map(k =>
    '<div class="stats-kpi" style="--kpi-color:' + k.color + '">' +
    '<div class="stats-kpi-icon"><svg width="16" height="16"><use href="#ic-' + k.icon + '"/></svg></div>' +
    '<span class="stats-kpi-val">' + k.val + '</span>' +
    '<span class="stats-kpi-label">' + k.label + '</span>' +
    '</div>'
  ).join('') +
  '</div>' +

  // ── OS : donut + légende + barres ──
  '<div class="stats-two-col">' +

  '<div class="stats-section">' +
  '<h3 class="stats-section-title">Répartition par OS</h3>' +
  '<div class="stats-donut-center">' + donutSVG + '</div>' +
  (sortedOS.length ? '<div class="stats-legend">' + donutLegend + '</div>' : '') +
  '</div>' +

  '<div class="stats-section">' +
  '<div class="stats-section-header">' +
  '<h3 class="stats-section-title" style="margin:0">Détail par famille</h3>' +
  '<div class="stats-toggle">' +
  '<button class="stats-toggle-btn' + (_statsBarsMode==='count'?' active':'') + '" data-mode="count">Nombre</button>' +
  '<button class="stats-toggle-btn' + (_statsBarsMode==='size'?' active':'') + '" data-mode="size">Taille</button>' +
  '</div>' +
  '</div>' +
  '<div class="stats-os-bars" id="statsOsBars">' + renderOsBars(_statsBarsMode) + '</div>' +
  '</div>' +

  '</div>' + // stats-two-col

  // ── Statuts ──
  (statusData.length > 0 ?
  '<div class="stats-section">' +
  '<h3 class="stats-section-title">Statuts</h3>' +
  '<div class="stats-status-pills">' +
  statusData.map(s =>
    '<div class="stats-status-pill" style="border-color:' + s.color + '20;background:' + s.color + '10">' +
    '<svg width="12" height="12" style="color:' + s.color + '"><use href="#ic-' + s.icon + '"/></svg>' +
    '<span class="stats-status-label">' + s.label + '</span>' +
    '<span class="stats-status-val" style="color:' + s.color + '">' + s.val + '</span>' +
    '</div>'
  ).join('') +
  '</div></div>' : '') +

  // ── Top 5 taille ──
  '<div class="stats-section">' +
  '<h3 class="stats-section-title">Les plus volumineuses</h3>' +
  '<div class="stats-top-list">' +
  topItems.map((iso,i) => {
    const pct = Math.round((iso.size_bytes||0) / maxTopSize * 100);
    const rankColors = ['var(--orange)','var(--txt-2)','var(--txt-3)','var(--txt-3)','var(--txt-3)'];
    const grp = osGroupKey(iso);
    const dot = osColors[grp] || '#555';
    return '<div class="stats-top-row2">' +
      '<span class="stats-top-rank2" style="color:' + rankColors[i] + '">' + (i+1) + '</span>' +
      '<div class="stats-top-info">' +
      '<div class="stats-top-name2">' +
      '<span class="stats-os-dot" style="background:' + dot + '"></span>' +
      esc(iso.name) +
      '</div>' +
      '<div class="stats-top-bar-wrap"><div class="stats-top-bar" style="width:' + pct + '%;background:' + dot + '40"></div></div>' +
      '</div>' +
      '<span class="stats-top-size2">' + fmtSize(iso.size_bytes) + '</span>' +
      '</div>';
  }).join('') +
  '</div></div>' +

  '</div>';

  // Toggle nombre / taille
  body.querySelectorAll('.stats-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _statsBarsMode = btn.dataset.mode;
      body.querySelectorAll('.stats-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === _statsBarsMode));
      document.getElementById('statsOsBars').innerHTML = renderOsBars(_statsBarsMode);
    });
  });
}

function makeDonutSVG(counts, colors, total) {
  const size = 160, cx = 80, cy = 80, r = 62, innerR = 42;
  if (!total) return '<svg width="' + size + '" height="' + size + '"></svg>';
  const tau = 2 * Math.PI;
  let startAngle = -Math.PI / 2;
  let paths = '';
  const entries = Object.entries(counts).sort((a,b) => b[1]-a[1]);
  entries.forEach(([k, v], idx) => {
    const angle = (v / total) * tau;
    const endAngle = startAngle + angle;
    const gap = 0.03;
    const sa = startAngle + (idx === 0 ? 0 : gap);
    const ea = endAngle - gap;
    const x1 = cx + r * Math.cos(sa),       y1 = cy + r * Math.sin(sa);
    const x2 = cx + r * Math.cos(ea),       y2 = cy + r * Math.sin(ea);
    const xi1 = cx + innerR * Math.cos(ea), yi1 = cy + innerR * Math.sin(ea);
    const xi2 = cx + innerR * Math.cos(sa), yi2 = cy + innerR * Math.sin(sa);
    const large = (ea - sa) > Math.PI ? 1 : 0;
    const color = colors[k] || '#555566';
    paths += '<path d="M ' + x1 + ' ' + y1 +
      ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x2 + ' ' + y2 +
      ' L ' + xi1 + ' ' + yi1 +
      ' A ' + innerR + ' ' + innerR + ' 0 ' + large + ' 0 ' + xi2 + ' ' + yi2 +
      ' Z" fill="' + color + '"/>';
    startAngle = endAngle;
  });
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + innerR + '" fill="var(--bg-3)"/>' +
    paths +
    '<text x="' + cx + '" y="' + (cy-8) + '" text-anchor="middle" fill="var(--txt)" font-size="26" font-weight="800" font-family="inherit">' + total + '</text>' +
    '<text x="' + cx + '" y="' + (cy+10) + '" text-anchor="middle" fill="var(--txt-3)" font-size="11" font-family="inherit">ISOs</text>' +
    '</svg>';
}

// ── SYSTEM INFO & MAINTENANCE ──────────────────────────────────────

let _sysInfo = null;

async function loadSystemInfo() {
  try {
    const d = await fetch('/api/system-info').then(r => r.json());
    _sysInfo = d;
    const el = document.getElementById('statStoragePath');
    el.textContent = d.iso_storage_path;
    el.title = d.iso_storage_path;

    // Avertissement quota disque dans le header
    const existingWarn = document.getElementById('diskQuotaWarn');
    if (d.disk_quota_exceeded) {
      if (!existingWarn) {
        const warn = document.createElement('div');
        warn.id = 'diskQuotaWarn';
        warn.className = 'disk-quota-warn';
        warn.innerHTML = `${svg('alert',13)} Disque plein — ${d.disk?.pct}% utilisé. Uploads et téléchargements bloqués.`;
        document.querySelector('header')?.after(warn);
      }
    } else if (existingWarn) {
      existingWarn.remove();
    }
  } catch {}
}

function openMaintenance() {
  openModal('modalMaintenance');
  _populateMaintSysInfo();
  document.getElementById('maintLog').textContent = '';
}

async function _populateMaintSysInfo() {
  try {
    const d = await fetch('/api/system-info').then(r => r.json());
    _sysInfo = d;
    document.getElementById('maintStoragePath').textContent = d.iso_storage_path;
    document.getElementById('maintDbPath').textContent = d.db_path;
    document.getElementById('maintDbSize').textContent = fmtSize(d.db_size_bytes);
    if (d.disk) {
      const fill = document.getElementById('maintDiskFill');
      const label = document.getElementById('maintDiskLabel');
      fill.style.width = d.disk.pct + '%';
      fill.style.background = d.disk.pct > 85 ? 'var(--red)' : d.disk.pct > 65 ? 'var(--orange)' : 'var(--green)';
      label.textContent = fmtSize(d.disk.used) + ' / ' + fmtSize(d.disk.total) + ' (' + d.disk.pct + '%)';
    }
  } catch {}
}

function _maintLog(msg, ok) {
  const log = document.getElementById('maintLog');
  const ts = new Date().toLocaleTimeString();
  const color = ok === true ? 'var(--green)' : ok === false ? 'var(--red)' : 'var(--txt-2)';

  const entry = document.createElement('div');
  entry.className = 'maint-log-entry';
  entry.style.color = color;

  const tsSpan = document.createElement('span');
  tsSpan.className = 'maint-log-ts';
  tsSpan.textContent = ts;

  const msgSpan = document.createElement('span');
  msgSpan.className = 'maint-log-msg';
  msgSpan.textContent = msg;

  entry.appendChild(tsSpan);
  entry.appendChild(msgSpan);
  log.insertBefore(entry, log.firstChild);
}

function _setBtnLoading(cardId, loading) {
  const btn = document.querySelector('#' + cardId + ' .btn');
  if (!btn) return;
  btn.disabled = loading;
  btn.querySelector('.spinner')?.classList.toggle('active', loading);
}

async function maintIntegrity() {
  _setBtnLoading('cardIntegrity', true);
  try {
    const d = await fetch('/api/maintenance/integrity').then(r => r.json());
    _maintLog(d.message, d.ok);
    if (!d.ok && d.result?.length) {
      d.result.forEach(r => _maintLog('  ' + r, false));
    }
  } catch(e) { _maintLog('Erreur réseau: ' + e.message, false); }
  _setBtnLoading('cardIntegrity', false);
}

async function maintVacuum() {
  _setBtnLoading('cardVacuum', true);
  try {
    const d = await fetch('/api/maintenance/vacuum', { method: 'POST' }).then(r => r.json());
    _maintLog(d.message + (d.db_size_bytes ? ' (DB: ' + fmtSize(d.db_size_bytes) + ')' : ''), d.success);
    if (d.success) _populateMaintSysInfo();
  } catch(e) { _maintLog('Erreur réseau: ' + e.message, false); }
  _setBtnLoading('cardVacuum', false);
}

async function maintReindex() {
  _setBtnLoading('cardReindex', true);
  try {
    const d = await fetch('/api/maintenance/reindex', { method: 'POST' }).then(r => r.json());
    _maintLog(d.message, d.success);
  } catch(e) { _maintLog('Erreur réseau: ' + e.message, false); }
  _setBtnLoading('cardReindex', false);
}

async function maintCleanOrphans() {
  _setBtnLoading('cardOrphans', true);
  try {
    const d = await fetch('/api/maintenance/cleanup-orphans', { method: 'POST' }).then(r => r.json());
    _maintLog(d.message, d.success);
    if (d.items?.length) {
      d.items.forEach(i => _maintLog('  Supprimé: ' + i.name + ' (' + i.filename + ')', null));
    }
    if (d.removed > 0) { loadISOs(); loadStats(); }
  } catch(e) { _maintLog('Erreur réseau: ' + e.message, false); }
  _setBtnLoading('cardOrphans', false);
}
