/**
 * Manage Infrastructure Fields - Vanilla JavaScript Controller
 * 
 * Interacts directly with Supabase-backed API to manage read-only
 * permissions for school infrastructure fields without PHP.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ManageInfraFields = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const DEFAULT_FIELDS = [
    { key: 'kitchen_status', label: 'Kitchen cum Store Status' },
    { key: 'kitchen_year', label: 'Kitchen Store Construction Year' },
    { key: 'repair_grant_status', label: 'Kitchen cum Store Repairing Grant Rs. 10000/- (10 years) received status' },
    { key: 'repair_grant_year', label: 'Repairing Grant (Rs. 10000/-) Receive Year' },
    { key: 'dining_status', label: 'Dining Hall Status' },
    { key: 'dining_fund', label: 'Dining Hall Fund sanctioned from' },
    { key: 'nutrition_status', label: 'Nutrition Garden Status' },
    { key: 'kitchen_device_status', label: 'Kitchen Device Status' },
    { key: 'kitchen_device_year', label: 'Kitchen Device Replacement Grant receive Year' },
    { key: 'toilet_separate', label: 'Separate Toilet for Boys and Girls' },
    { key: 'elec_status', label: 'Electric Connection Status' },
    { key: 'water_facilities', label: 'Drinking Water Facilities' },
    { key: 'water_purifier', label: 'Water Purifier' },
    { key: 'water_remarks', label: 'Remarks (if Any Requirement)' }
  ];

  let isSaving = false;
  let activeConfig = {};

  /**
   * Enforce Main Admin authentication session
   */
  async function checkAdminAuth() {
    if (typeof window === 'undefined' || window.location.protocol === 'file:') return true;
    try {
      const res = await fetch('/api/auth/session?admin_type=main', {
        cache: 'no-store',
        credentials: 'same-origin'
      });
      if (!res.ok) throw new Error('Session check failed');
      const data = await res.json();
      if (!data || !data.authenticated || data.admin_type !== 'main') {
        window.location.replace('admin_login.html');
        return false;
      }
      return true;
    } catch (err) {
      window.location.replace('admin_login.html');
      return false;
    }
  }

  /**
   * Fetch current field configuration from Supabase
   */
  async function loadConfiguration() {
    try {
      const res = await fetch('/api/infrastructure/config', {
        cache: 'no-store',
        credentials: 'same-origin'
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          window.location.replace('admin_login.html');
          return null;
        }
        throw new Error(`Server returned HTTP ${res.status}`);
      }
      const data = await res.json();
      return data && data.config ? data.config : {};
    } catch (err) {
      console.error('Failed to load infrastructure configuration:', err);
      throw err;
    }
  }

  /**
   * Persist complete 14-field configuration to Supabase
   */
  async function saveConfiguration(configPayload) {
    const res = await fetch('/api/infrastructure/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      credentials: 'same-origin',
      body: JSON.stringify({ config: configPayload })
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        window.location.replace('admin_login.html');
        return null;
      }
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.message || `Save failed with HTTP ${res.status}`);
    }

    return await res.json();
  }

  /**
   * Update individual row style matching original UI
   */
  function updateRowStyle(checkbox) {
    if (!checkbox) return;
    const row = checkbox.closest('.field-row');
    if (!row) return;

    const badge = row.querySelector('.status-badge');
    const iconBox = row.querySelector('.icon-box');
    const icon = iconBox ? iconBox.querySelector('i') : null;

    if (checkbox.checked) {
      // Locked State
      if (badge) {
        badge.textContent = "LOCKED";
        badge.className = "status-badge font-bold text-xs uppercase tracking-wider px-3 py-1 rounded-full bg-red-100 text-red-700 w-24 text-center shadow-sm";
      }
      row.classList.add('bg-red-50/30', 'border-red-100');
      row.classList.remove('bg-white');

      if (iconBox) {
        iconBox.className = "icon-box w-12 h-12 rounded-full flex items-center justify-center text-lg transition-colors bg-red-100 text-red-500";
      }
      if (icon) {
        icon.className = "fas fa-lock";
      }
    } else {
      // Unlocked State
      if (badge) {
        badge.textContent = "EDITABLE";
        badge.className = "status-badge font-bold text-xs uppercase tracking-wider px-3 py-1 rounded-full bg-green-100 text-green-700 w-24 text-center";
      }
      row.classList.remove('bg-red-50/30', 'border-red-100');
      row.classList.add('bg-white');

      if (iconBox) {
        iconBox.className = "icon-box w-12 h-12 rounded-full flex items-center justify-center text-lg transition-colors bg-slate-100 text-slate-500 group-hover:bg-blue-50 group-hover:text-blue-500";
      }
      if (icon) {
        icon.className = "fas fa-cube";
      }
    }
  }

  /**
   * Render all 14 field rows into the container
   */
  function renderFields(config) {
    const container = document.getElementById('fieldsContainer');
    if (!container) return;

    activeConfig = config || {};
    container.innerHTML = '';

    DEFAULT_FIELDS.forEach(f => {
      const isLocked = Boolean(activeConfig[f.key]);
      const div = document.createElement('div');
      div.className = 'field-row bg-white p-5 rounded-2xl border border-slate-100 flex items-center justify-between transition-all group hover:border-blue-100';
      div.dataset.key = f.key;

      div.innerHTML = `
        <div class="flex items-center gap-4">
            <div class="icon-box w-12 h-12 rounded-full flex items-center justify-center text-lg transition-colors bg-slate-100 text-slate-500 group-hover:bg-blue-50 group-hover:text-blue-500">
                <i class="fas fa-cube"></i>
            </div>
            <div>
                <label class="font-bold text-slate-700 text-lg block cursor-pointer select-none" for="${f.key}">
                    ${f.label}
                </label>
                <span class="text-xs font-mono text-slate-400 mt-1 block">ID: ${f.key}</span>
            </div>
        </div>

        <div class="flex items-center gap-4">
            <span class="status-badge font-bold text-xs uppercase tracking-wider px-3 py-1 rounded-full bg-green-100 text-green-700 w-24 text-center">
                Editable
            </span>
            <label class="switch" for="${f.key}">
                <input type="checkbox" id="${f.key}" name="${f.key}" 
                    class="lock-checkbox"
                    aria-label="${f.label}"
                    ${isLocked ? 'checked' : ''}>
                <span class="slider"></span>
            </label>
        </div>
      `;

      container.appendChild(div);

      const cb = div.querySelector('.lock-checkbox');
      cb.addEventListener('change', function () {
        updateRowStyle(this);
      });

      updateRowStyle(cb);
    });
  }

  /**
   * Lock or unlock all currently visible rows (respecting search filter)
   */
  function toggleAll(shouldLock) {
    const checkboxes = document.querySelectorAll('.lock-checkbox');
    checkboxes.forEach(cb => {
      const row = cb.closest('.field-row');
      if (row && row.style.display !== 'none') {
        cb.checked = shouldLock;
        updateRowStyle(cb);
      }
    });
  }

  /**
   * Setup live search filtering by label and key ID
   */
  function setupSearch() {
    const searchInput = document.getElementById('searchInput');
    if (!searchInput) return;

    searchInput.addEventListener('input', function (e) {
      const term = (e.target.value || '').toLowerCase().trim();
      const rows = document.querySelectorAll('.field-row');

      rows.forEach(row => {
        const label = row.querySelector('label');
        const mono = row.querySelector('.font-mono');
        const text = label ? label.textContent.toLowerCase() : '';
        const id = mono ? mono.textContent.toLowerCase() : '';

        if (text.includes(term) || id.includes(term)) {
          row.style.display = 'flex';
        } else {
          row.style.display = 'none';
        }
      });
    });
  }

  /**
   * Show alert notification
   */
  function showNotification(element, message = null) {
    if (!element) return;
    if (message) {
      const textSpan = element.querySelector('span');
      if (textSpan) textSpan.textContent = message;
    }
    element.classList.remove('hidden');
    element.classList.add('flex');
  }

  /**
   * Hide alert notification
   */
  function hideNotification(element) {
    if (!element) return;
    element.classList.add('hidden');
    element.classList.remove('flex');
  }

  /**
   * Save button click handler
   */
  async function handleSave() {
    if (isSaving) return;

    const saveBtn = document.getElementById('saveBtn');
    const successBanner = document.getElementById('successNotification');
    const errorBanner = document.getElementById('errorNotification');

    hideNotification(successBanner);
    hideNotification(errorBanner);

    // Read full current state of all 14 checkboxes (including hidden rows)
    const configToPersist = {};
    DEFAULT_FIELDS.forEach(f => {
      const cb = document.getElementById(f.key);
      configToPersist[f.key] = cb ? Boolean(cb.checked) : false;
    });

    try {
      isSaving = true;
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Saving Changes...</span>';
      }

      const res = await saveConfiguration(configToPersist);
      if (res && res.status === 'success') {
        activeConfig = res.config || configToPersist;
        showNotification(successBanner, res.message || 'Field visibility settings updated successfully!');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        throw new Error((res && res.message) || 'Unknown error occurred while saving.');
      }
    } catch (err) {
      console.error('Save configuration error:', err);
      showNotification(errorBanner, 'Failed to save configuration: ' + err.message);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      isSaving = false;
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> <span>Save Changes</span>';
      }
    }
  }

  /**
   * Page Initialization
   */
  async function initPage() {
    const isAuth = await checkAdminAuth();
    if (!isAuth) return;

    const loadingSpinner = document.getElementById('loadingSpinner');
    const fieldsContainer = document.getElementById('fieldsContainer');

    setupSearch();

    try {
      if (loadingSpinner) loadingSpinner.classList.remove('hidden');
      if (fieldsContainer) fieldsContainer.classList.add('hidden');

      const config = await loadConfiguration();
      renderFields(config || {});

      if (loadingSpinner) loadingSpinner.classList.add('hidden');
      if (fieldsContainer) fieldsContainer.classList.remove('hidden');
    } catch (err) {
      console.error('Initialization error:', err);
      const errorBanner = document.getElementById('errorNotification');
      showNotification(errorBanner, 'Failed to load configuration from Supabase: ' + err.message);

      // Render default fields with all unlocked as graceful fallback
      renderFields({});
      if (loadingSpinner) loadingSpinner.classList.add('hidden');
      if (fieldsContainer) fieldsContainer.classList.remove('hidden');
    }
  }

  return {
    DEFAULT_FIELDS,
    checkAdminAuth,
    loadConfiguration,
    saveConfiguration,
    updateRowStyle,
    renderFields,
    toggleAll,
    setupSearch,
    handleSave,
    initPage
  };
});
