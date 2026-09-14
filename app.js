/**
 * Claud-Cloud Operations Feed Frontend
 * Lightweight vanilla JavaScript (< 250 lines, zero external dependencies)
 */

(function () {
  'use strict';

  let refreshTimer = null;
  let countdown = 60;
  const OLD_ITEM_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

  function toPersianDigits(input) {
    const fa = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
    return String(input).replace(/[0-9]/g, (d) => fa[d]);
  }

  function timeAgo(isoString) {
    if (!isoString) return '--';
    const date = new Date(isoString);
    const now = new Date();
    const diffSec = Math.floor((now - date) / 1000);
    if (diffSec < 60) return `${toPersianDigits(diffSec)} ثانیه پیش`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${toPersianDigits(diffMin)} دقیقه پیش`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${toPersianDigits(diffHour)} ساعت پیش`;
    const diffDay = Math.floor(diffHour / 24);
    return `${toPersianDigits(diffDay)} روز پیش`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function loadStatusFeed() {
    const btn = document.getElementById('btn-refresh');
    if (btn) btn.textContent = 'در حال به‌روزرسانی...';

    try {
      const resp = await fetch(`/api/status?t=${Date.now()}`);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      const data = await resp.json();
      renderDashboard(data);
    } catch (err) {
      console.error('Failed to load status feed:', err);
      showErrorState(err.message);
    } finally {
      if (btn) btn.textContent = 'تازه‌سازی';
      countdown = 60;
    }
  }

  function showErrorState(msg) {
    const banner = document.getElementById('banner-section');
    if (banner) {
      banner.className = 'banner banner-amber';
      document.getElementById('banner-badge').textContent = 'خطای دریافت';
      document.getElementById('banner-headline').textContent = 'به‌روزرسانی فید با تأخیر مواجه شد';
      document.getElementById('banner-subline').textContent = `دریافت اطلاعات ناموفق بود (${msg}). به‌طور خودکار دوباره تلاش می‌شود.`;
    }
  }

  function renderStuckGroup(container, items, emptyMessage) {
    if (items.length === 0) {
      if (emptyMessage) {
        container.innerHTML = `
          <div class="empty-quiet-box">
            <span class="check-icon">✓</span>
            <p>${emptyMessage}</p>
          </div>`;
      } else {
        container.innerHTML = '';
      }
      return;
    }
    container.innerHTML = items.map(item => `
      <div class="stuck-card ${item.severity === 'amber' ? 'amber' : ''}">
        <div class="stuck-info">
          <div class="stuck-header">
            <span class="stuck-type-badge">${escapeHtml(item.type)}</span>
            <span class="stuck-title">${escapeHtml(item.title)}</span>
          </div>
          <div class="stuck-detail">${escapeHtml(item.account)} &bull; ${escapeHtml(item.detail)} &bull; ${timeAgo(item.timestamp)}</div>
        </div>
        ${item.url ? `
        <div class="stuck-action">
          <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">بررسی &larr;</a>
        </div>` : ''}
      </div>
    `).join('');
  }

  function renderDashboard(data) {
    latestFeedData = data;
    const meta = data.metadata || {};
    const overview = data.overview || {};
    const projects = data.projects || [];
    const stuckItems = data.stuck_items || [];
    const runs = data.recent_runs || [];

    // 1. Meta Controls
    document.getElementById('meta-domain').textContent = meta.subdomain || 'status.airboxvip.top';
    document.getElementById('meta-updated').textContent = timeAgo(meta.generated_at);

    // Indicator in topbar
    const indicator = document.getElementById('global-indicator');
    indicator.className = 'indicator';
    if (overview.system_status === 'red') indicator.classList.add('red');
    else if (overview.system_status === 'amber') indicator.classList.add('amber');

    // 2. Banner
    const banner = document.getElementById('banner-section');
    banner.className = `banner banner-${overview.system_status || 'green'}`;
    const badge = document.getElementById('banner-badge');
    const statusLabels = { green: 'نرمال', amber: 'هشدار', red: 'قرمز' };
    badge.textContent = statusLabels[overview.system_status] || 'نرمال';

    document.getElementById('banner-headline').textContent = overview.headline || 'همه‌چیز نرمال است';

    // Gate chip aggregates pass/total across every project with a measured
    // gate suite -- a project with no Reports/gates (e.g. this dashboard
    // itself) contributes 0/0 and is skipped rather than dragging the sum down.
    const measuredProjects = projects.filter(p => (p.gates || {}).total > 0);
    const gatesPassSum = measuredProjects.reduce((s, p) => s + (p.gates.pass || 0), 0);
    const gatesTotalSum = measuredProjects.reduce((s, p) => s + (p.gates.total || 0), 0);
    document.getElementById('chip-gates').textContent = `${gatesPassSum}/${gatesTotalSum}`;

    const chipRed = document.getElementById('chip-red');
    chipRed.textContent = toPersianDigits(overview.red_count || 0);
    chipRed.className = (overview.red_count > 0) ? 'chip-num chip-alert-red' : 'chip-num chip-alert-zero';

    const onlineProjects = projects.filter(p => p.status !== 'offline_unconfigured').length;
    document.getElementById('chip-projects').textContent = `${onlineProjects}/${overview.total_projects || projects.length}`;

    // 3. Stuck & Red Attention Center -- split into recent (<=24h) and
    // older, shown behind a toggle so old, already-seen items don't
    // clutter the default view.
    const now = Date.now();
    const recentItems = [];
    const olderItems = [];
    stuckItems.forEach(item => {
      const t = item.timestamp ? new Date(item.timestamp).getTime() : now;
      if (now - t > OLD_ITEM_THRESHOLD_MS) olderItems.push(item);
      else recentItems.push(item);
    });

    const stuckList = document.getElementById('stuck-list');
    const stuckBadge = document.getElementById('stuck-count-badge');
    stuckBadge.textContent = `${toPersianDigits(stuckItems.length)} مورد`;
    stuckBadge.className = stuckItems.length > 0 ? 'badge badge-red' : 'badge badge-green';

    renderStuckGroup(
      stuckList,
      recentItems,
      'موردی گیر نکرده. همه‌ی گردش‌کارها موفق، بدون تسک مسدود و بدون خطای push.'
    );

    const olderWrap = document.getElementById('stuck-older-wrap');
    const olderList = document.getElementById('stuck-older-list');
    const olderCountEl = document.getElementById('stuck-older-count');
    if (olderItems.length > 0) {
      olderWrap.style.display = '';
      olderCountEl.textContent = toPersianDigits(olderItems.length);
      renderStuckGroup(olderList, olderItems, null);
    } else {
      olderWrap.style.display = 'none';
      olderList.style.display = 'none';
    }

    // 4. Per-Project Cards
    renderProjects(projects);
    buildProjectsMenu(projects);

    document.getElementById('projects-count-label').textContent =
      `${toPersianDigits(projects.length)} پروژه`;

    // 5. Recent Actions Runs Across All Projects
    const tbody = document.getElementById('tasks-tbody');
    if (runs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">هیچ اجرای اخیری ثبت نشده.</td></tr>';
    } else {
      const conclusionLabels = { success: 'موفق', failure: 'ناموفق', timed_out: 'اتمام‌مهلت', in_progress: 'در حال اجرا', unknown: 'نامشخص' };
      tbody.innerHTML = runs.slice(0, 20).map(r => {
        const conc = (r.conclusion || r.status || 'unknown').toLowerCase();
        let badgeClass = 'task-conclusion-badge';
        if (conc === 'success') badgeClass += ' success';
        else if (conc === 'failure' || conc === 'timed_out') badgeClass += ' failure';
        else badgeClass += ' in_progress';

        return `
          <tr>
            <td><span class="${badgeClass}">${escapeHtml(conclusionLabels[conc] || conc)}</span></td>
            <td>${escapeHtml(r.project)}</td>
            <td>${escapeHtml(r.name)}</td>
            <td><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" class="footer-link" dir="ltr">#${escapeHtml(r.id)}</a></td>
            <td><span class="acc-meta-tag" dir="ltr">${escapeHtml(r.event || 'push')}</span></td>
            <td><span class="acc-meta-tag">${timeAgo(r.created_at)}</span></td>
          </tr>
        `;
      }).join('');
    }
  }

  function renderProjects(projects) {
    const grid = document.getElementById('projects-grid');
    const statusLabels = { green: 'سالم', amber: 'هشدار', red: 'نیازمند توجه', offline_unconfigured: 'آفلاین' };
    const pillClass = { green: 'status-pill-green', amber: 'status-pill-red', red: 'status-pill-red', offline_unconfigured: 'status-pill-neutral' };

    grid.innerHTML = projects.map(proj => {
      const g = proj.gates || {};
      const hasGates = (g.total || 0) > 0;
      const gateFail = (g.fail || 0) > 0 || g.status === 'fail';

      const gateBlock = hasGates ? `
        <div class="gate-numbers">
          <div class="gate-stat">
            <span class="stat-big" dir="ltr">${g.pass || 0}</span>
            <span class="stat-sub">موفق</span>
          </div>
          <div class="gate-stat">
            <span class="stat-big ${gateFail ? 'stat-fail' : ''}" dir="ltr">${g.fail || 0}</span>
            <span class="stat-sub">ناموفق</span>
          </div>
          <div class="gate-stat">
            <span class="stat-big" dir="ltr">${g.total || 0}</span>
            <span class="stat-sub">مجموع</span>
          </div>
        </div>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill ${gateFail ? 'has-fail' : ''}" style="width: ${Math.round(((g.pass || 0) / (g.total || 1)) * 100)}%;"></div>
        </div>
        <div class="gate-detail-row">
          <span class="gate-detail-label">آخرین گزارش:</span>
          <code class="code-sm" dir="ltr">${escapeHtml(g.source || '--')}</code>
        </div>
      ` : `
        <p class="text-muted text-sm">${escapeHtml(g.note || 'گیتی برای این پروژه اندازه‌گیری نشده.')}</p>
      `;

      const commitBlock = proj.latest_commit ? `
        <div class="gate-detail-row">
          <span class="gate-detail-label">آخرین کامیت:</span>
          <a href="${escapeHtml(proj.latest_commit.html_url)}" target="_blank" rel="noopener" class="code-sm" dir="ltr">${escapeHtml(proj.latest_commit.sha)}</a>
        </div>
        <p class="text-muted text-sm" title="${escapeHtml(proj.latest_commit.message)}">${escapeHtml(proj.latest_commit.message)} &bull; ${timeAgo(proj.latest_commit.date)}</p>
      ` : '';

      const openIssuesCount = (proj.open_issues || []).length;

      return `
        <div class="card project-card" id="project-${proj.key}">
          <div class="card-header">
            <div>
              <h4 dir="ltr">${escapeHtml(proj.name)}</h4>
              <p class="text-muted text-sm">${escapeHtml(proj.role || '')}</p>
            </div>
            <span class="status-pill ${pillClass[proj.status] || 'status-pill-neutral'}">${statusLabels[proj.status] || proj.status}</span>
          </div>
          <div class="card-body">
            ${gateBlock}
            ${commitBlock}
            <div class="gate-detail-row">
              <span class="gate-detail-label">مخزن:</span>
              <code class="code-sm" dir="ltr">${escapeHtml(proj.repo)}</code>
            </div>
            <div class="gate-detail-row">
              <span class="gate-detail-label">Issue های باز:</span>
              <span dir="ltr">${toPersianDigits(openIssuesCount)}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function buildProjectsMenu(projects) {
    const list = document.getElementById('menu-projects-list');
    if (!list) return;
    list.innerHTML = projects.map(proj => `
      <li><a href="#project-${proj.key}" class="menu-link" role="menuitem">${escapeHtml(proj.name)}</a></li>
    `).join('');
  }

  let latestFeedData = null;
  let deferredInstallPrompt = null;
  const DEFAULT_VAPID_PUBLIC_KEY = 'BG_JbNQKSkg6lQHIYAuJdrfXVMr4lttYSmouPlhSJ2tMQkKnFtJdDKaIFrd02oAn16BbE7sHOyzFkNijd-gELvA';

  function urlB64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  async function getVapidPublicKey() {
    if (latestFeedData && latestFeedData.push_config && latestFeedData.push_config.vapid_public_key) {
      return latestFeedData.push_config.vapid_public_key;
    }
    try {
      const resp = await fetch('vapid_public.json');
      if (resp.ok) {
        const d = await resp.json();
        if (d.publicKey) return d.publicKey;
      }
    } catch (e) {
      // Fallback to embedded default
    }
    return DEFAULT_VAPID_PUBLIC_KEY;
  }

  async function persistSubscription(subscription) {
    const subJson = subscription.toJSON ? subscription.toJSON() : subscription;
    const bodyStr = JSON.stringify(subJson);

    // Save to local storage
    try {
      localStorage.setItem('claud_cloud_push_subscription', bodyStr);
    } catch (e) {}

    // POST to /api/subscribe (Vercel Serverless Function), which persists
    // it into the status gist server-side (a Gist write always needs an
    // authenticated token, so there is no direct-from-browser path here).
    let persisted = false;
    try {
      const resp = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyStr
      });
      const data = await resp.json().catch(() => null);
      persisted = !!(resp.ok && data && data.status === 'success');
    } catch (err) {
      // Non-fatal if running as purely static deployment
    }

    return persisted;
  }

  async function setupPushNotifications(registration) {
    const btn = document.getElementById('btn-push-subscribe');
    if (!btn) return;

    if (!('PushManager' in window) || !('Notification' in window)) {
      btn.textContent = 'اعلان پشتیبانی نمی‌شود';
      btn.className = 'btn-sm btn-push denied';
      btn.disabled = true;
      return;
    }

    async function refreshButtonState() {
      if (Notification.permission === 'denied') {
        btn.textContent = '🔕 اعلان مسدود شده';
        btn.className = 'btn-sm btn-push denied';
        btn.title = 'اعلان‌ها در تنظیمات مرورگر مسدود شده‌اند';
        return;
      }

      const existingSub = await registration.pushManager.getSubscription();
      if (existingSub) {
        btn.textContent = '🔔 اعلان فعال';
        btn.className = 'btn-sm btn-push active';
        btn.title = 'اعلان‌ها فعال است. برای بررسی/همگام‌سازی مجدد کلیک کنید.';
      } else {
        btn.textContent = '🔔 فعال‌سازی اعلان';
        btn.className = 'btn-sm btn-push';
        btn.title = 'دریافت اعلان هنگام بروز مورد قرمز یا گیرکرده';
      }
    }

    await refreshButtonState();

    btn.addEventListener('click', async () => {
      try {
        if (Notification.permission === 'denied') {
          alert('اعلان‌ها در تنظیمات مرورگر شما مسدود شده‌اند. لطفاً برای دریافت هشدارهای عملیاتی آن‌ها را فعال کنید.');
          return;
        }

        btn.textContent = 'در حال اتصال...';

        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          await refreshButtonState();
          return;
        }

        const pubKeyStr = await getVapidPublicKey();
        const appServerKey = urlB64ToUint8Array(pubKeyStr);

        let sub = await registration.pushManager.getSubscription();
        if (!sub) {
          sub = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: appServerKey
          });
        }

        await persistSubscription(sub);
        await refreshButtonState();

        // Trigger welcome confirmation notification
        registration.showNotification('اعلان‌های Claud-Cloud فعال شد', {
          body: 'فید عملیات متصل شد. هنگام بروز موارد قرمز یا گیرکرده اعلان دریافت خواهید کرد.',
          icon: 'icons/icon-192.png',
          badge: 'icons/icon-192.png',
          tag: 'claud-cloud-welcome'
        });
      } catch (err) {
        console.error('[PWA] Push subscription error:', err);
        alert(`خطا در فعال‌سازی اعلان: ${err.message}`);
        await refreshButtonState();
      }
    });
  }

  function initPwa() {
    // 1. Register Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then((registration) => {
          console.log('[PWA] Service Worker registered:', registration.scope);
          setupPushNotifications(registration);
        })
        .catch((err) => {
          console.warn('[PWA] Service Worker registration failed:', err);
        });
    }

    // 2. Android "Add to Home screen" install prompt
    const installBtn = document.getElementById('btn-pwa-install');
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (installBtn) {
        installBtn.style.display = 'inline-flex';
      }
    });

    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        console.log('[PWA] Install prompt outcome:', outcome);
        deferredInstallPrompt = null;
        installBtn.style.display = 'none';
      });
    }

    window.addEventListener('appinstalled', () => {
      console.log('[PWA] Claud-Cloud Operations Feed installed.');
      if (installBtn) installBtn.style.display = 'none';
    });
  }

  // --- Chat with @agy ---
  // The site has no direct-LLM shortcut on purpose: every reply comes from
  // the real @agy GitHub bot (see api/agy_create.js, api/agy_status.js).
  // AGY_SELF_LOGIN_HINT filters OUR OWN echoed comments back out of the
  // polled reply list (we already show what we sent optimistically) --
  // it assumes the chat PAT's GitHub login contains "mohammadlali" (ACC0),
  // matching every other Mohammadlali/* repo reference in this fleet.
  const AGY_SELF_LOGIN_HINT = 'mohammadlali';
  const AGY_POLL_INTERVAL_MS = 12000;
  const AGY_STORAGE_KEY = 'agy_chat_issue_number';

  let agyIssueNumber = null;
  let agyPollTimer = null;
  let agySeenReplyIds = new Set();

  function agyChatEmptyHtml() {
    return '<div class="agy-chat-empty" id="agy-chat-empty">' +
      'هر سوالی درباره‌ی شرکت بپرس -- AGY با آگاهی از اسناد داخلی جواب می‌دهد. ' +
      'برای واگذاری یک کار واقعی (کد، رفع باگ، دیپلوی) در انتهای پیام ' +
      '<code dir="ltr">@agy</code> بنویس تا یک ایشوی رسمی باز شود.</div>';
  }

  function agyAppendMessage(cls, html) {
    const log = document.getElementById('agy-chat-log');
    if (!log) return null;
    const empty = document.getElementById('agy-chat-empty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = `agy-msg ${cls}`;
    el.innerHTML = html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function agyStopPolling() {
    if (agyPollTimer) {
      clearInterval(agyPollTimer);
      agyPollTimer = null;
    }
  }

  function agyStartPolling() {
    agyStopPolling();
    agyPollReplies();
    agyPollTimer = setInterval(agyPollReplies, AGY_POLL_INTERVAL_MS);
  }

  // A bot reply carrying a task-breakdown proposal (agy-plan-bot.yml on
  // agw-workers) ends with a fenced ```json block: {"kind":
  // "tbs_task_proposal", "tasks": [...]}. Detected here so it renders as
  // an Accept/Decline card instead of plain chat text.
  function agyParseProposal(body) {
    if (!body) return null;
    const m = /```json\s*([\s\S]*?)```/.exec(body);
    if (!m) return null;
    try {
      const obj = JSON.parse(m[1]);
      if (obj && obj.kind === 'tbs_task_proposal' && Array.isArray(obj.tasks)) {
        return { proposal: obj, prose: body.slice(0, m.index).trim() };
      }
    } catch (e) {
      // not valid JSON -- not a proposal, fall through to plain text
    }
    return null;
  }

  function agyRenderProposalCard(parsed, createdAt) {
    const { proposal, prose } = parsed;

    // Only the LATEST proposal on the issue is what agy-plan-dispatch.yml
    // will actually read -- disable every earlier card's buttons so a
    // stale one can't be accidentally approved.
    document
      .querySelectorAll('.agy-proposal-card')
      .forEach((el) => el.classList.add('is-superseded'));

    const tasks = proposal.tasks || [];
    const taskItems = tasks
      .map((t) => {
        const acc = t && t.account !== undefined && t.account !== null ? t.account : '?';
        const member = t && t.member_id ? `${escapeHtml(t.member_id)} · ` : '';
        return `<li class="agy-proposal-task">
          <div class="agy-proposal-task-title">${escapeHtml((t && t.title) || 'task')}</div>
          <div class="agy-proposal-task-meta">${member}ACC${acc}</div>
        </li>`;
      })
      .join('');

    const html = `
      <div class="agy-proposal-summary">${escapeHtml(prose)}</div>
      <ul class="agy-proposal-tasks">${taskItems}</ul>
      <div class="agy-proposal-actions">
        <button type="button" class="btn-sm btn-proposal-accept" data-proposal-action="accept">✅ تایید و اجرا (${tasks.length} کار)</button>
        <button type="button" class="btn-sm btn-proposal-decline" data-proposal-action="decline-toggle">✏️ رد + اصلاح</button>
      </div>
      <div class="agy-proposal-decline-box">
        <textarea class="agy-proposal-decline-note" rows="2" placeholder="چه چیزی باید عوض بشه؟"></textarea>
        <button type="button" class="btn-sm btn-proposal-decline" data-proposal-action="decline-send">ارسال اصلاح</button>
      </div>
      <div class="agy-proposal-status"></div>
      <span class="agy-msg-meta">AGY · ${timeAgo(createdAt)}</span>
    `;

    const el = agyAppendMessage('agy-msg-bot agy-proposal-card', html);
    if (!el) return;

    const statusEl = el.querySelector('.agy-proposal-status');
    const declineBox = el.querySelector('.agy-proposal-decline-box');

    el.querySelector('[data-proposal-action="accept"]').addEventListener('click', () => {
      agyProposalAction(el, 'accept', '');
    });
    el.querySelector('[data-proposal-action="decline-toggle"]').addEventListener('click', () => {
      declineBox.classList.toggle('open');
    });
    el.querySelector('[data-proposal-action="decline-send"]').addEventListener('click', () => {
      const note = el.querySelector('.agy-proposal-decline-note').value.trim();
      if (!note) {
        statusEl.textContent = 'توضیح اصلاح رو بنویس.';
        return;
      }
      agyProposalAction(el, 'decline', note);
    });
  }

  async function agyProposalAction(cardEl, action, note) {
    const statusEl = cardEl.querySelector('.agy-proposal-status');
    const buttons = cardEl.querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    statusEl.textContent = action === 'accept' ? 'در حال تایید...' : 'در حال ارسال اصلاح...';
    try {
      const resp = await fetch('/api/agy_plan_action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue_number: agyIssueNumber, action, note }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        statusEl.textContent = `خطا: ${escapeHtml(data.error || 'نامشخص')}`;
        buttons.forEach((b) => { b.disabled = false; });
        return;
      }
      cardEl.classList.add('is-superseded');
      statusEl.textContent = action === 'accept'
        ? '✅ تایید شد -- دیسپچ دسته‌ای در حال اجراست.'
        : '✏️ اصلاح ارسال شد -- منتظر پروپوزال جدید...';
    } catch (err) {
      statusEl.textContent = 'خطا در ارتباط.';
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  async function agyPollReplies() {
    if (!agyIssueNumber) return;
    try {
      const resp = await fetch(`/api/agy_status?issue_number=${agyIssueNumber}`);
      if (!resp.ok) return;
      const data = await resp.json();
      for (const reply of data.replies || []) {
        const id = reply.html_url || `${reply.author}-${reply.created_at}`;
        if (agySeenReplyIds.has(id)) continue;
        agySeenReplyIds.add(id);
        if (reply.author && reply.author.toLowerCase().includes(AGY_SELF_LOGIN_HINT)) continue;
        const parsed = agyParseProposal(reply.body);
        if (parsed) {
          agyRenderProposalCard(parsed, reply.created_at);
        } else {
          agyAppendMessage(
            'agy-msg-bot',
            `${escapeHtml(reply.body || '')}<span class="agy-msg-meta">AGY · ${timeAgo(reply.created_at)}</span>`
          );
        }
      }
    } catch (err) {
      console.error('agy_status poll failed:', err);
    }
  }

  async function agySendMessage(text) {
    const sendBtn = document.getElementById('agy-chat-send');
    const projectSelect = document.getElementById('agy-project-select');

    agyAppendMessage('agy-msg-user', escapeHtml(text));
    if (sendBtn) sendBtn.disabled = true;
    const pending = agyAppendMessage('agy-msg-pending', 'AGY در حال بررسی است...');

    try {
      const resp = await fetch('/api/agy_create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          project: projectSelect ? projectSelect.value : '',
          issue_number: agyIssueNumber,
        }),
      });
      const data = await resp.json();
      if (pending) pending.remove();

      if (!resp.ok) {
        agyAppendMessage('agy-msg-system', `خطا: ${escapeHtml(data.error || 'نامشخص')}`);
        return;
      }

      if (data.status === 'created') {
        agyIssueNumber = data.issue_number;
        agySeenReplyIds.clear();
        try { localStorage.setItem(AGY_STORAGE_KEY, String(agyIssueNumber)); } catch (e) { /* ignore */ }
        const label = data.mode === 'task' ? 'ایشوی جدید (کار واقعی)' : 'گفتگوی جدید';
        agyAppendMessage(
          'agy-msg-system',
          `${label} باز شد -- <a href="${data.issue_url}" target="_blank" rel="noopener">Issue #${data.issue_number}</a>`
        );
      }
      agyStartPolling();
    } catch (err) {
      if (pending) pending.remove();
      agyAppendMessage('agy-msg-system', `خطای شبکه: ${escapeHtml(err.message)}`);
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  function agyResetChat() {
    agyStopPolling();
    agyIssueNumber = null;
    agySeenReplyIds.clear();
    try { localStorage.removeItem(AGY_STORAGE_KEY); } catch (e) { /* ignore */ }
    const log = document.getElementById('agy-chat-log');
    if (log) log.innerHTML = agyChatEmptyHtml();
  }

  function initAgyChat() {
    const form = document.getElementById('agy-chat-form');
    const input = document.getElementById('agy-chat-input');
    const newChatBtn = document.getElementById('btn-agy-new-chat');
    const planBtn = document.getElementById('agy-chat-plan');
    if (!form || !input) return;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      agySendMessage(text);
    });

    if (planBtn) {
      planBtn.addEventListener('click', () => {
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        // Strip any marker the user may have typed by habit -- this
        // button always asks for a PLAN, never a direct task or a
        // dispatch approval, regardless of what's in the textbox.
        const stripped = text.replace(/\s*@agy(-plan(-approved)?)?\s*$/i, '').trim();
        agySendMessage(`${stripped} @agy-plan`);
      });
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    if (newChatBtn) newChatBtn.addEventListener('click', agyResetChat);

    // Resume a conversation that survived a page reload -- AGY's own
    // dispatch can take minutes, longer than a user is likely to keep a
    // tab open and waiting.
    let savedIssue = null;
    try { savedIssue = localStorage.getItem(AGY_STORAGE_KEY); } catch (e) { /* ignore */ }
    if (savedIssue) {
      agyIssueNumber = parseInt(savedIssue, 10) || null;
      if (agyIssueNumber) {
        agyAppendMessage(
          'agy-msg-system',
          `ادامه‌ی گفتگوی قبلی -- <a href="https://github.com/mohammadlali0707-stack/agw-workers/issues/${agyIssueNumber}" target="_blank" rel="noopener">Issue #${agyIssueNumber}</a>`
        );
        agyStartPolling();
      }
    }
  }

  function initMenu() {
    const toggleBtn = document.getElementById('btn-menu-toggle');
    const panel = document.getElementById('menu-panel');
    if (!toggleBtn || !panel) return;

    function closeMenu() {
      panel.hidden = true;
      toggleBtn.setAttribute('aria-expanded', 'false');
    }

    function openMenu() {
      panel.hidden = false;
      toggleBtn.setAttribute('aria-expanded', 'true');
    }

    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel.hidden) openMenu(); else closeMenu();
    });

    // Close after picking a link (mobile-friendly single tap to navigate).
    panel.addEventListener('click', (e) => {
      if (e.target.closest('a.menu-link')) closeMenu();
    });

    document.addEventListener('click', (e) => {
      if (!panel.hidden && !panel.contains(e.target) && e.target !== toggleBtn) closeMenu();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) closeMenu();
    });
  }

  // Setup event listeners and interval
  document.addEventListener('DOMContentLoaded', () => {
    loadStatusFeed();
    initPwa();
    initMenu();
    initAgyChat();

    const btn = document.getElementById('btn-refresh');
    if (btn) btn.addEventListener('click', loadStatusFeed);

    const showOlderBtn = document.getElementById('btn-show-older');
    if (showOlderBtn) {
      showOlderBtn.addEventListener('click', () => {
        const olderList = document.getElementById('stuck-older-list');
        const isHidden = olderList.style.display === 'none';
        olderList.style.display = isHidden ? '' : 'none';
        showOlderBtn.classList.toggle('expanded', isHidden);
      });
    }

    const countdownEl = document.getElementById('meta-countdown');
    setInterval(() => {
      countdown--;
      if (countdown <= 0) {
        loadStatusFeed();
      } else if (countdownEl) {
        countdownEl.textContent = `${countdown}s`;
      }
    }, 1000);
  });
})();
