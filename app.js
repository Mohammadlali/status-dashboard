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
      const resp = await fetch(`status.json?t=${Date.now()}`);
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
    const gates = data.gates || {};
    const ccpGates = gates.claud_cloud_project || {};
    const crGates = gates.control_room || {};
    const stuckItems = data.stuck_items || [];
    const tasks = data.recent_agy_tasks || [];
    const accounts = data.accounts || [];

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
    document.getElementById('chip-gates').textContent = `${ccpGates.pass || 0}/${ccpGates.total || 0}`;

    const chipRed = document.getElementById('chip-red');
    chipRed.textContent = toPersianDigits(overview.red_count || 0);
    chipRed.className = (overview.red_count > 0) ? 'chip-num chip-alert-red' : 'chip-num chip-alert-zero';

    document.getElementById('chip-accounts').textContent = `${overview.active_accounts || 0}/${overview.total_accounts || 9}`;

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

    // 4. Gate Health Cards
    document.getElementById('gate-pass-val').textContent = ccpGates.pass || '--';
    document.getElementById('gate-fail-val').textContent = ccpGates.fail || '0';
    document.getElementById('gate-total-val').textContent = ccpGates.total || '--';
    document.getElementById('gate-report-source').textContent = ccpGates.source || '--';
    document.getElementById('gate-commit-sha').textContent = ccpGates.commit ? ccpGates.commit.substring(0, 7) : 'HEAD';

    const ccpPill = document.getElementById('ccp-gate-pill');
    const ccpOverall = document.getElementById('gate-overall-badge');
    const fill = document.getElementById('gate-progress-fill');
    if ((ccpGates.fail || 0) > 0 || ccpGates.status === 'fail') {
      ccpPill.className = 'status-pill status-pill-red';
      ccpPill.textContent = 'ناموفق';
      ccpOverall.className = 'badge badge-red';
      ccpOverall.textContent = 'ناموفق';
      fill.className = 'progress-bar-fill has-fail';
      const pct = Math.round((ccpGates.pass / (ccpGates.total || 1)) * 100);
      fill.style.width = `${pct}%`;
    } else {
      ccpPill.className = 'status-pill status-pill-green';
      ccpPill.textContent = 'موفق';
      ccpOverall.className = 'badge badge-green';
      ccpOverall.textContent = 'موفق';
      fill.className = 'progress-bar-fill';
      fill.style.width = '100%';
    }

    // Control Room gate card
    const crPill = document.getElementById('cr-gate-pill');
    const crStatusText = document.getElementById('cr-gate-status-text');
    const crArtifact = document.getElementById('cr-gate-artifact');
    const crDesc = document.getElementById('cr-gate-desc');

    if (crGates.status === 'connected') {
      crPill.className = 'status-pill status-pill-green';
      crPill.textContent = 'متصل';
      crStatusText.textContent = 'در دسترس از طریق ACC6_PAT';
      crArtifact.textContent = crGates.latest_file || '--';
      crDesc.textContent = 'تاریخچه‌ی گیت‌های Control-Room با موفقیت بررسی شد.';
    } else {
      crPill.className = 'status-pill status-pill-neutral';
      crPill.textContent = 'اندازه‌گیری‌نشده';
      crStatusText.textContent = crGates.status || 'آفلاین / وصل‌نشده';
      crArtifact.textContent = '--';
      crDesc.textContent = crGates.note || 'نیازمند secret به نام ACC6_PAT در گردش‌کار دیپلوی است.';
    }

    // 5. Recent @agy Task Outcomes
    const tbody = document.getElementById('tasks-tbody');
    if (tasks.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">هیچ تسک اخیری ثبت نشده.</td></tr>';
    } else {
      const conclusionLabels = { success: 'موفق', failure: 'ناموفق', timed_out: 'اتمام‌مهلت', in_progress: 'در حال اجرا', unknown: 'نامشخص' };
      tbody.innerHTML = tasks.slice(0, 15).map(t => {
        const conc = (t.conclusion || t.status || 'unknown').toLowerCase();
        let badgeClass = 'task-conclusion-badge';
        if (conc === 'success') badgeClass += ' success';
        else if (conc === 'failure' || conc === 'timed_out') badgeClass += ' failure';
        else badgeClass += ' in_progress';

        return `
          <tr>
            <td><span class="${badgeClass}">${escapeHtml(conclusionLabels[conc] || conc)}</span></td>
            <td><code dir="ltr">${escapeHtml(t.repo)}</code></td>
            <td>${escapeHtml(t.name)}</td>
            <td><a href="${escapeHtml(t.url)}" target="_blank" rel="noopener" class="footer-link" dir="ltr">#${escapeHtml(t.id)}</a></td>
            <td><span class="acc-meta-tag" dir="ltr">${escapeHtml(t.event || 'push')}</span></td>
            <td><span class="acc-meta-tag">${timeAgo(t.created_at)}</span></td>
          </tr>
        `;
      }).join('');
    }

    // 6. 9-Account Fleet Grid
    const fleetGrid = document.getElementById('fleet-grid');
    fleetGrid.innerHTML = accounts.map(acc => {
      const isRed = (acc.failed_runs && acc.failed_runs.length > 0) || (acc.blocked_issues && acc.blocked_issues.length > 0);
      const isOffline = !acc.token_available;
      const statusPillClass = isRed ? 'status-pill-red' : (isOffline ? 'status-pill-neutral' : 'status-pill-green');
      const statusText = isRed ? 'نیازمند توجه' : (isOffline ? 'آفلاین' : 'آنلاین');

      const commitsHtml = (acc.commits && acc.commits.length > 0)
        ? acc.commits.slice(0, 3).map(c => `
            <li class="acc-commit-item">
              <a href="${escapeHtml(c.html_url)}" target="_blank" rel="noopener" class="code-sm" dir="ltr">${escapeHtml(c.sha)}</a>
              <span class="acc-commit-msg" title="${escapeHtml(c.message)}">${escapeHtml(c.message)}</span>
              <span class="acc-meta-tag">${timeAgo(c.date)}</span>
            </li>`).join('')
        : '<li class="text-muted text-sm">بدون فعالیت اخیر در کامیت‌ها</li>';

      const issuesHtml = (acc.open_issues && acc.open_issues.length > 0)
        ? acc.open_issues.slice(0, 3).map(iss => `
            <li class="acc-issue-item">
              <span class="acc-issue-title">
                <a href="${escapeHtml(iss.url)}" target="_blank" rel="noopener" class="footer-link" dir="ltr">#${iss.number}</a>
                ${escapeHtml(iss.title)}
              </span>
              ${iss.is_blocked ? '<span class="issue-blocked-tag">مسدود</span>' : ''}
              ${iss.is_stale ? '<span class="issue-stale-tag">بدون‌پاسخ</span>' : ''}
            </li>`).join('')
        : '<li class="text-muted text-sm">بدون issue باز</li>';

      return `
        <div class="account-card ${isRed ? 'acc-red' : ''}">
          <div class="acc-header">
            <div class="acc-title-wrap">
              <span class="acc-badge" dir="ltr">ACC${acc.index}</span>
              <div>
                <div class="acc-owner" dir="ltr">${escapeHtml(acc.owner)}</div>
                <div class="acc-role">${escapeHtml(acc.role)}</div>
              </div>
            </div>
            <span class="status-pill ${statusPillClass}">${statusText}</span>
          </div>
          <div class="acc-body">
            <div>
              <div class="acc-section-title">کامیت‌های اخیر</div>
              <ul class="acc-commits-list">${commitsHtml}</ul>
            </div>
            <div>
              <div class="acc-section-title">Issue ها و تسک‌ها (${toPersianDigits((acc.open_issues || []).length)} باز)</div>
              <ul class="acc-issues-list">${issuesHtml}</ul>
            </div>
          </div>
        </div>
      `;
    }).join('');
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

    // 1. If R2 presigned upload URL is available, PUT directly to R2
    let uploadedR2 = false;
    if (latestFeedData && latestFeedData.push_config && latestFeedData.push_config.r2_upload_url) {
      try {
        const r2Resp = await fetch(latestFeedData.push_config.r2_upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: bodyStr
        });
        if (r2Resp.ok) {
          uploadedR2 = true;
          console.log('[PWA] Subscription persisted to Cloudflare R2 via presigned URL.');
        }
      } catch (err) {
        console.warn('[PWA] Direct R2 presigned PUT failed:', err);
      }
    }

    // 2. Also attempt POST to /api/subscribe (Vercel Serverless Function)
    try {
      await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyStr
      });
    } catch (err) {
      // Non-fatal if running as purely static deployment
    }

    return uploadedR2;
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

  // Setup event listeners and interval
  document.addEventListener('DOMContentLoaded', () => {
    loadStatusFeed();
    initPwa();

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
