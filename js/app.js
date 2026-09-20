/**
 * 网络小说文本托管器 H5 应用核心交互逻辑
 */

// 全局应用状态
const AppState = {
  books: [],
  currentBook: null,
  currentCategory: '全部',
  currentFilter: '未读', // 全部 | 未读 | 已读
  readStatus: {}, // { [bookId]: Set<itemId> }
  darkMode: false,
  activeTab: 'home', // home | settings
  currentView: 'home', // home | chapters | settings
  lastCopiedItem: null, // { bookId, itemId } 用于 Toast 撤销
  toastTimeout: null,
  textCache: new Map(), // 缓存已加载的章节文本，确保极速同步复制
  // Gist 云端同步状态
  ghToken: '',
  gistId: '',
  syncStatus: 'unbound', // unbound | syncing | connected | error
  syncTimer: null,
  statusModifiedAt: 0 // 本地已读状态最后修改时间戳
};

// 本地存储键
const STORAGE_KEYS = {
  READ_STATUS: 'novel_read_status_v1',
  STATUS_MODIFIED_AT: 'novel_status_modified_at_v1',
  DARK_MODE: 'novel_dark_mode_v1',
  GH_TOKEN: 'novel_gh_token_v1',
  GIST_ID: 'novel_gist_id_v1',
  LAST_SYNC: 'novel_gist_last_sync_v1'
};


// 初始化
document.addEventListener('DOMContentLoaded', () => {
  initStorage();
  initTheme();
  initGistSync();
  bindGlobalEvents();
  loadBooksData();
});

// 1. 初始化持久化存储
function initStorage() {
  // 禁止浏览器自动恢复滚动位置，确保视图切换时精准重置到顶部
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }

  try {
    const rawRead = localStorage.getItem(STORAGE_KEYS.READ_STATUS);
    if (rawRead) {
      const parsed = JSON.parse(rawRead);
      AppState.readStatus = {};
      for (const [k, v] of Object.entries(parsed)) {
        AppState.readStatus[k] = new Set(v);
      }
    }
  } catch (e) {
    console.error('加载阅读状态失败:', e);
    AppState.readStatus = {};
  }

  AppState.statusModifiedAt = parseInt(localStorage.getItem(STORAGE_KEYS.STATUS_MODIFIED_AT) || '0', 10);
  AppState.darkMode = localStorage.getItem(STORAGE_KEYS.DARK_MODE) === 'true';
}

function saveReadStatus(updateTime = true) {
  try {
    const serialized = {};
    for (const [k, v] of Object.entries(AppState.readStatus)) {
      serialized[k] = Array.from(v);
    }
    localStorage.setItem(STORAGE_KEYS.READ_STATUS, JSON.stringify(serialized));
    if (updateTime) {
      AppState.statusModifiedAt = Date.now();
      localStorage.setItem(STORAGE_KEYS.STATUS_MODIFIED_AT, AppState.statusModifiedAt.toString());
    }
  } catch (e) {
    console.error('保存阅读状态失败:', e);
  }
}

// 2. 主题管理 (同时作用于 html 和 body，杜绝滚动露白)
function initTheme() {
  const toggleInput = document.getElementById('dark-mode-toggle');
  const applyDark = (isDark) => {
    document.body.classList.toggle('dark-mode', isDark);
    document.documentElement.classList.toggle('dark-mode', isDark);
  };

  if (AppState.darkMode) {
    applyDark(true);
    if (toggleInput) toggleInput.checked = true;
  }
  if (toggleInput) {
    toggleInput.addEventListener('change', (e) => {
      AppState.darkMode = e.target.checked;
      applyDark(AppState.darkMode);
      localStorage.setItem(STORAGE_KEYS.DARK_MODE, AppState.darkMode);
    });
  }
}

// 3. 加载图书数据
async function loadBooksData() {
  try {
    // 添加时间戳防止 GitHub Pages 静态缓存导致新增章节未及时同步
    const resp = await fetch(`books.json?t=${Date.now()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    AppState.books = await resp.json();
    renderCategories();
    renderBookList();
  } catch (e) {
    console.error('加载 books.json 失败:', e);
    showToast('加载书库数据失败，请检查 books.json 文件', false);
  }
}

// 4. 动态提取并渲染分类标签（严格来源于已有小说）
function renderCategories() {
  const container = document.getElementById('category-pills');
  if (!container) return;

  // 严格从当前已有小说中动态提取分类（保持出现顺序并去重）
  const extractedCategories = [];
  AppState.books.forEach(b => {
    const cat = b.category ? b.category.trim() : '';
    if (cat && !extractedCategories.includes(cat)) {
      extractedCategories.push(cat);
    }
  });

  // 如果没有分类或只有 1 种分类，则无需分类筛选栏
  if (extractedCategories.length <= 1) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';

  // 分类列表：包含 "全部" 以及从已有小说中动态提取出的分类
  const categories = ['全部', ...extractedCategories];

  // 校验当前分类有效性
  if (!categories.includes(AppState.currentCategory)) {
    AppState.currentCategory = '全部';
  }

  container.innerHTML = categories.map(cat => `
    <button class="pill-btn ${cat === AppState.currentCategory ? 'active' : ''}" data-cat="${cat}">
      ${cat}
    </button>
  `).join('');

  container.querySelectorAll('.pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.getAttribute('data-cat');
      // 点击已激活的单项分类可再次取消，切回全部
      if (AppState.currentCategory === cat && cat !== '全部') {
        AppState.currentCategory = '全部';
      } else {
        AppState.currentCategory = cat;
      }
      renderCategories();
      renderBookList();
    });
  });
}

// 5. 渲染书库列表
function renderBookList() {
  const container = document.getElementById('book-card-list');
  if (!container) return;

  const filtered = AppState.currentCategory === '全部'
    ? AppState.books
    : AppState.books.filter(b => b.category === AppState.currentCategory);

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
        <p>暂无【${AppState.currentCategory}】分类的小说</p>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(book => {
    const readSet = AppState.readStatus[book.id] || new Set();
    const readCount = book.items.filter(item => readSet.has(item.id)).length;
    const totalCount = book.totalItems || book.items.length;
    const unreadCount = Math.max(0, totalCount - readCount);
    const progressPercent = totalCount > 0 ? Math.round((readCount / totalCount) * 100) : 0;

    return `
      <div class="book-card" data-book-id="${book.id}">
        <img class="book-cover" src="${book.cover || ''}" alt="${book.title}" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'92\\' height=\\'128\\'><rect width=\\'100%\\' height=\\'100%\\' fill=\\'%23e2e8f0\\'/><text x=\\'50%\\' y=\\'50%\\' dominant-baseline=\\'middle\\' text-anchor=\\'middle\\' fill=\\'%2364748b\\' font-size=\\'12\\'>封面暂缺</text></svg>'">
        <div class="book-info">
          <div>
            <div class="book-title-row">
              <span class="book-title">${book.title}</span>
              <span class="category-tag ${book.category || ''}">${book.category || '网络小说'}</span>
            </div>
            <p class="book-desc">${book.description || '暂无简介'}</p>
          </div>
          <div>
            <div class="progress-container">
              <div class="progress-bar">
                <div class="progress-fill" style="width: ${progressPercent}%;"></div>
              </div>
              <span class="progress-text">${progressPercent}%</span>
            </div>
            <div class="book-action-row">
              <div class="book-stats">
                <div class="stat-item">
                  <span class="stat-label">总条目数</span>
                  <span class="stat-num">${totalCount}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">已阅读</span>
                  <span class="stat-num highlight">${readCount}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">未阅读</span>
                  <span class="stat-num">${unreadCount}</span>
                </div>
              </div>
              <button class="enter-btn" data-book-id="${book.id}">
                进入 ➔
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // 点击卡片直接进入小说
  container.querySelectorAll('.book-card').forEach(card => {
    card.addEventListener('click', () => {
      const bookId = card.getAttribute('data-book-id');
      openBookChapters(bookId);
    });
  });
}

// 6. 打开小说的章节列表内层
function openBookChapters(bookId) {
  const book = AppState.books.find(b => b.id === bookId);
  if (!book) return;

  AppState.currentBook = book;
  AppState.currentFilter = '未读';

  // 设置导航标题与小封面
  document.getElementById('chapter-nav-title').textContent = book.title;
  const navCover = document.getElementById('chapter-nav-cover');
  if (navCover) {
    navCover.src = book.cover || '';
    navCover.alt = book.title;
  }

  // 重置筛选标签（默认选中未读）
  const filterTabs = document.querySelectorAll('#chapter-filter-tabs .filter-tab');
  filterTabs.forEach(tab => {
    tab.classList.toggle('active', tab.getAttribute('data-filter') === '未读');
  });

  renderChapterStats();
  renderChapterList();
  switchView('chapters');
}

// 7. 渲染章节列表内层统计
function renderChapterStats() {
  if (!AppState.currentBook) return;
  const book = AppState.currentBook;
  const readSet = AppState.readStatus[book.id] || new Set();
  const readCount = book.items.filter(item => readSet.has(item.id)).length;
  const totalCount = book.totalItems || book.items.length;
  const unreadCount = Math.max(0, totalCount - readCount);

  document.getElementById('c-stat-total').textContent = totalCount;
  document.getElementById('c-stat-read').textContent = readCount;
  document.getElementById('c-stat-unread').textContent = unreadCount;
}

// 8. 渲染章节条目列表
function renderChapterList() {
  if (!AppState.currentBook) return;
  const container = document.getElementById('chapter-list');
  if (!container) return;

  const book = AppState.currentBook;
  const readSet = AppState.readStatus[book.id] || new Set();

  let items = book.items;
  if (AppState.currentFilter === '未读') {
    items = items.filter(item => !readSet.has(item.id));
  } else if (AppState.currentFilter === '已读') {
    items = items.filter(item => readSet.has(item.id));
  }

  if (items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
        <p>暂无【${AppState.currentFilter}】条件的章节条目</p>
      </div>
    `;
    return;
  }

  container.innerHTML = items.map(item => {
    const isRead = readSet.has(item.id);
    const displaySnippet = (item.snippet && !item.snippet.endsWith('-'))
      ? item.snippet
      : (item.id && item.id.includes('-')
          ? `《${book.title}》 ${item.id}章`
          : (item.snippet || `《${book.title}》 ${item.title}`));

    return `
      <div class="chapter-item-card ${isRead ? 'is-read' : ''}" data-item-id="${item.id}">
        <div class="item-left">
          <img class="item-cover-thumb" src="${book.cover || ''}" alt="封面" loading="lazy">
          <div class="item-texts">
            <span class="item-range-title">${item.title}</span>
            <div class="item-snippet">${displaySnippet}</div>
            ${item.wordCount ? `
              <div class="item-word-count" title="有效字数（仅含汉字和数字）">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
                <span>${item.wordCount.toLocaleString()} 字</span>
              </div>
            ` : ''}
          </div>
        </div>
        <div class="item-action">
          <button class="action-btn view-btn" data-action="view" data-item-id="${item.id}" title="查看并阅读">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
            查看
          </button>
          ${isRead
            ? `<button class="action-btn read-btn" data-action="toggle-read" data-item-id="${item.id}" title="点击撤销已读状态">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                已读
              </button>`
            : `<button class="action-btn copy-btn" data-action="copy" data-item-id="${item.id}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                复制
              </button>`
          }
        </div>
      </div>
    `;
  }).join('');

  // 绑定查看、复制与撤销事件
  container.querySelectorAll('[data-action="view"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const itemId = btn.getAttribute('data-item-id');
      const item = book.items.find(i => i.id === itemId);
      if (item) openReaderModal(book, item);
    });
  });

  container.querySelectorAll('[data-action="copy"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const itemId = btn.getAttribute('data-item-id');
      handleCopyItem(book.id, itemId);
    });
  });

  container.querySelectorAll('[data-action="toggle-read"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const itemId = btn.getAttribute('data-item-id');
      toggleItemRead(book.id, itemId);
    });
  });
}

// 9. 核心复制逻辑
async function handleCopyItem(bookId, itemId) {
  const book = AppState.books.find(b => b.id === bookId);
  if (!book) return;
  const item = book.items.find(i => i.id === itemId);
  if (!item) return;

  const btn = document.querySelector(`.chapter-item-card[data-item-id="${itemId}"] .copy-btn`);
  if (btn) {
    btn.innerHTML = `
      <svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle><path d="M12 2a10 10 0 0 1 10 10"></path></svg>
      复制中...
    `;
    btn.style.opacity = '0.7';
  }

  try {
    let text = AppState.textCache.get(item.path);
    if (!text) {
      const resp = await fetch(item.path);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      text = await resp.text();
      AppState.textCache.set(item.path, text);
    }

    // 写入剪贴板
    const success = await copyToClipboard(text);
    if (!success) {
      throw new Error('写入剪贴板失败');
    }

    // 计算有效字数（只包含汉字和数字，不含标点符号）
    const wordCount = item.wordCount || countValidChars(text);

    // 标记为已读
    markItemAsRead(bookId, itemId);

    // 弹出 Toast（展示具体复制的字数）
    AppState.lastCopiedItem = { bookId, itemId };
    showToast(`已复制 ${wordCount.toLocaleString()} 字到剪贴板！已自动标记为已读`, true, true);

    // 同步刷新视图
    renderChapterStats();
    renderChapterList();
    renderBookList();
  } catch (err) {
    console.error('复制失败:', err);
    showToast('复制失败，请重试或检查剪贴板权限', false);
    if (btn) {
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        复制
      `;
      btn.style.opacity = '1';
    }
  }
}

// 10. 剪贴板适配 (现代 API + 兜底)
async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      console.warn('navigator.clipboard 失败，尝试 fallback:', e);
    }
  }

  // 兜底方案
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.setAttribute('readonly', '');
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, 999999);
    const successful = document.execCommand('copy');
    document.body.removeChild(textarea);
    return successful;
  } catch (err) {
    console.error('execCommand 复制失败:', err);
    return false;
  }
}

// 11. 状态流转管理
function markItemAsRead(bookId, itemId) {
  if (!AppState.readStatus[bookId]) {
    AppState.readStatus[bookId] = new Set();
  }
  AppState.readStatus[bookId].add(itemId);
  saveReadStatus();
  triggerDebouncedGistSync();
}

function markItemAsUnread(bookId, itemId) {
  if (AppState.readStatus[bookId]) {
    AppState.readStatus[bookId].delete(itemId);
    saveReadStatus();
    triggerDebouncedGistSync();
  }
}

function toggleItemRead(bookId, itemId) {
  const readSet = AppState.readStatus[bookId];
  if (readSet && readSet.has(itemId)) {
    markItemAsUnread(bookId, itemId);
    showToast('已撤销已读状态', false);
  } else {
    markItemAsRead(bookId, itemId);
    showToast('已标记为已读', true);
  }
  renderChapterStats();
  renderChapterList();
  renderBookList();
}

// 14. 浮层 Toast 通知 (对齐设计图 3，上下结构，带撤销按钮)
function showToast(message, isSuccess = true, showUndo = false) {
  const toast = document.getElementById('toast-container');
  const textEl = document.getElementById('toast-text');
  const iconEl = document.getElementById('toast-icon');
  const undoBtn = document.getElementById('toast-undo-btn');

  if (!toast || !textEl) return;

  textEl.textContent = message;
  if (iconEl) {
    iconEl.style.fill = isSuccess ? '#10b981' : '#f87171';
  }
  if (undoBtn) {
    undoBtn.style.display = showUndo ? 'block' : 'none';
  }

  toast.classList.add('show');
  if (AppState.toastTimeout) clearTimeout(AppState.toastTimeout);

  AppState.toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 3500);
}

// 滚动重置函数
function scrollToTop(smooth = false) {
  const behavior = smooth ? 'smooth' : 'instant';
  window.scrollTo({ top: 0, left: 0, behavior });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  const app = document.getElementById('app');
  if (app) app.scrollTop = 0;
}

// 15. 视图与 Tab 切换
function switchView(viewName) {
  AppState.currentView = viewName;
  document.querySelectorAll('.view-container').forEach(el => {
    el.classList.remove('active');
  });

  const target = document.getElementById(`view-${viewName}`);
  if (target) target.classList.add('active');

  // 更新 Tab 选中高亮
  document.querySelectorAll('.nav-tab-btn').forEach(btn => {
    const tab = btn.getAttribute('data-tab');
    btn.classList.toggle('active', tab === (viewName === 'chapters' ? 'home' : viewName));
  });

  // 强力多阶段重置滚动位置，彻底消除视图切换时残留的滚动位移
  scrollToTop(false);
  requestAnimationFrame(() => {
    scrollToTop(false);
    setTimeout(() => scrollToTop(false), 20);
  });
}

// 16. 全局事件绑定
function bindGlobalEvents() {
  // 书库主页刷新按钮
  const homeRefreshBtn = document.getElementById('home-refresh-btn');
  if (homeRefreshBtn) {
    homeRefreshBtn.addEventListener('click', () => {
      homeRefreshBtn.classList.add('rotating');
      setTimeout(() => {
        location.reload();
      }, 150);
    });
  }

  // 点击章节顶部导航栏平滑回顶
  const chapterNav = document.querySelector('.chapter-nav-header');
  if (chapterNav) {
    chapterNav.addEventListener('click', (e) => {
      // 排除返回按钮的点击
      if (e.target.closest('#chapter-back-btn')) return;
      scrollToTop(true);
    });
  }

  // 底部导航栏点击
  document.querySelectorAll('.bottom-nav .nav-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      if (tab === 'home') {
        switchView('home');
      } else if (tab === 'settings') {
        switchView('settings');
      }
    });
  });

  // 章节列表页返回按钮
  const backBtn = document.getElementById('chapter-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      renderBookList();
      switchView('home');
    });
  }

  // 章节列表筛选 Tab
  document.querySelectorAll('#chapter-filter-tabs .filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#chapter-filter-tabs .filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      AppState.currentFilter = btn.getAttribute('data-filter');
      renderChapterList();
    });
  });

  // Toast 撤销按钮
  const undoBtn = document.getElementById('toast-undo-btn');
  if (undoBtn) {
    undoBtn.addEventListener('click', () => {
      if (AppState.lastCopiedItem) {
        const { bookId, itemId } = AppState.lastCopiedItem;
        markItemAsUnread(bookId, itemId);
        AppState.lastCopiedItem = null;
        const toast = document.getElementById('toast-container');
        if (toast) toast.classList.remove('show');
        showToast('已撤销已读状态', false);
        renderChapterStats();
        renderChapterList();
        renderBookList();
      }
    });
  }

  // 设置页：清空所有已读记录
  const clearReadBtn = document.getElementById('clear-read-btn');
  if (clearReadBtn) {
    clearReadBtn.addEventListener('click', () => {
      if (confirm('确定要清空所有小说的已阅读标记吗？此操作不可逆。')) {
        AppState.readStatus = {};
        saveReadStatus();
        renderBookList();
        showToast('已清空全部小说的已读标记', true);
      }
    });
  }

  // 阅读弹窗关闭与遮罩点击
  const readerCloseBtn = document.getElementById('reader-close-btn');
  const readerOverlay = document.getElementById('reader-overlay');
  if (readerCloseBtn) readerCloseBtn.addEventListener('click', closeReaderModal);
  if (readerOverlay) readerOverlay.addEventListener('click', closeReaderModal);

  // ESC 键快速关闭阅读弹窗
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('reader-modal');
      if (modal && modal.classList.contains('open')) {
        closeReaderModal();
      }
    }
  });
}

// ================= 章节查看与滚动阅读弹窗逻辑 =================
async function openReaderModal(book, item) {
  const modal = document.getElementById('reader-modal');
  const bookNameEl = document.getElementById('reader-book-name');
  const chapterRangeEl = document.getElementById('reader-chapter-range');
  const loadingEl = document.getElementById('reader-loading');
  const contentEl = document.getElementById('reader-content');
  const bodyEl = document.getElementById('reader-body');
  const copyBtn = document.getElementById('reader-copy-btn');

  if (!modal || !contentEl) return;

  // 设置头部标题与章节信息及字数
  if (bookNameEl) bookNameEl.textContent = book.title;
  const wordCountStr = item.wordCount ? ` · ${item.wordCount.toLocaleString()} 字` : '';
  if (chapterRangeEl) chapterRangeEl.textContent = `${item.title}${wordCountStr}`;

  // 重置内容与滚动位置
  contentEl.innerHTML = '';
  if (loadingEl) loadingEl.style.display = 'flex';
  if (bodyEl) bodyEl.scrollTop = 0;

  // 打开弹窗并禁用背景主页面滚动
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  // 绑定弹窗内复制按钮
  if (copyBtn) {
    copyBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
      复制
    `;
    copyBtn.onclick = async () => {
      await handleCopyItem(book.id, item.id);
      copyBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
        已复制
      `;
      setTimeout(() => {
        copyBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          复制
        `;
      }, 2000);
    };
  }

  // 加载正文文本（优先从内存缓存获取，没有则 fetch 异步拉取）
  try {
    let text = AppState.textCache.get(item.path);
    if (!text) {
      const resp = await fetch(item.path);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      text = await resp.text();
      AppState.textCache.set(item.path, text);
    }

    // 格式化文本为段落（按换行拆分，过滤空白，转义 HTML）
    const paragraphs = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    if (paragraphs.length === 0) {
      contentEl.innerHTML = '<p style="color: var(--text-tertiary); text-align: center;">本章节暂无文本内容</p>';
    } else {
      contentEl.innerHTML = paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join('');
    }

    if (loadingEl) loadingEl.style.display = 'none';
  } catch (err) {
    console.error('加载章节内容失败:', err);
    if (loadingEl) loadingEl.style.display = 'none';
    contentEl.innerHTML = `
      <div class="empty-state" style="padding: 40px 0;">
        <p style="color: var(--accent-red, #ef4444);">加载章节文本失败，请稍后重试</p>
      </div>
    `;
  }
}

function closeReaderModal() {
  const modal = document.getElementById('reader-modal');
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }
  document.body.style.overflow = '';
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// 统计有效字数（只包含汉字和数字，不包含标点符号与空白字符）
function countValidChars(text) {
  if (!text) return 0;
  const matches = text.match(/[\u4e00-\u9fa50-9]/g);
  return matches ? matches.length : 0;
}


// ================= 17. GitHub Gist 云端多设备同步实现 =================
function initGistSync() {
  AppState.ghToken = localStorage.getItem(STORAGE_KEYS.GH_TOKEN) || '';
  AppState.gistId = localStorage.getItem(STORAGE_KEYS.GIST_ID) || '';

  const tokenInput = document.getElementById('gh-token-input');
  const toggleVisBtn = document.getElementById('toggle-token-vis');
  const bindBtn = document.getElementById('bind-token-btn');
  const unbindBtn = document.getElementById('unbind-token-btn');
  const syncNowBtn = document.getElementById('sync-now-btn');
  const copyGistBtn = document.getElementById('copy-gist-id-btn');

  if (AppState.ghToken) {
    if (tokenInput) tokenInput.value = AppState.ghToken;
    AppState.syncStatus = 'connected';
    updateSyncUI();
    // 自动后台拉取云端最新数据并双向合并
    syncGist(true);
  } else {
    AppState.syncStatus = 'unbound';
    updateSyncUI();
  }

  // 密码可见性切换
  if (toggleVisBtn && tokenInput) {
    toggleVisBtn.addEventListener('click', () => {
      const isPwd = tokenInput.type === 'password';
      tokenInput.type = isPwd ? 'text' : 'password';
      toggleVisBtn.style.color = isPwd ? 'var(--accent-blue)' : 'var(--text-tertiary)';
    });
  }

  // 绑定 Token
  if (bindBtn) {
    bindBtn.addEventListener('click', async () => {
      const token = tokenInput ? tokenInput.value.trim() : '';
      if (!token) {
        showToast('请输入有效的 GitHub Token', false);
        return;
      }
      bindBtn.disabled = true;
      bindBtn.textContent = '正在连接 GitHub...';
      try {
        await connectAndSyncGist(token);
        showToast('云端同步已成功连接！', true);
      } catch (err) {
        console.error('连接 Gist 失败:', err);
        showToast(`连接失败: ${err.message || '请检查 Token 权限'}`, false);
        AppState.syncStatus = 'error';
        updateSyncUI();
      } finally {
        bindBtn.disabled = false;
        bindBtn.textContent = '连接并同步进度';
      }
    });
  }

  // 手动立即同步
  if (syncNowBtn) {
    syncNowBtn.addEventListener('click', async () => {
      if (!AppState.ghToken) return;
      syncNowBtn.disabled = true;
      try {
        await syncGist(false);
        showToast('云端进度同步完成！', true);
      } catch (err) {
        console.error('手动同步失败:', err);
        showToast('同步失败，请检查网络或 Token', false);
      } finally {
        syncNowBtn.disabled = false;
      }
    });
  }

  // 复制 Gist ID
  if (copyGistBtn) {
    copyGistBtn.addEventListener('click', async () => {
      if (AppState.gistId) {
        await copyToClipboard(AppState.gistId);
        showToast('Gist ID 已复制到剪贴板', true);
      }
    });
  }

  // 解绑 Token
  if (unbindBtn) {
    unbindBtn.addEventListener('click', () => {
      if (confirm('确定要断开与云端的同步连接吗？本地已读记录将保留。')) {
        AppState.ghToken = '';
        AppState.gistId = '';
        AppState.syncStatus = 'unbound';
        localStorage.removeItem(STORAGE_KEYS.GH_TOKEN);
        localStorage.removeItem(STORAGE_KEYS.GIST_ID);
        localStorage.removeItem(STORAGE_KEYS.LAST_SYNC);
        if (tokenInput) tokenInput.value = '';
        updateSyncUI();
        showToast('已断开云端同步', true);
      }
    });
  }
}

function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

// 更新同步卡片 UI 状态
function updateSyncUI() {
  const dot = document.getElementById('sync-status-dot');
  const text = document.getElementById('sync-status-text');
  const bindForm = document.getElementById('sync-bind-form');
  const infoBox = document.getElementById('sync-info-box');
  const syncNowBtn = document.getElementById('sync-now-btn');
  const gistIdEl = document.getElementById('sync-gist-id');
  const lastTimeEl = document.getElementById('sync-last-time');

  if (!dot || !text) return;

  dot.className = 'sync-dot';

  if (AppState.syncStatus === 'connected') {
    dot.classList.add('connected');
    text.textContent = '已连接 GitHub 云端同步';
    if (bindForm) bindForm.style.display = 'none';
    if (infoBox) infoBox.style.display = 'flex';
    if (syncNowBtn) syncNowBtn.style.display = 'inline-flex';
    if (gistIdEl) gistIdEl.textContent = AppState.gistId ? `${AppState.gistId.slice(0, 8)}...` : '自动托管';
    const gistLink = document.getElementById('view-gist-link');
    if (gistLink && AppState.gistId) {
      gistLink.href = `https://gist.github.com/${AppState.gistId}`;
    }
    const lastTime = localStorage.getItem(STORAGE_KEYS.LAST_SYNC);
    if (lastTimeEl) lastTimeEl.textContent = lastTime ? formatTimeAgo(parseInt(lastTime, 10)) : '刚刚';
  } else if (AppState.syncStatus === 'syncing') {
    dot.classList.add('syncing');
    text.textContent = '正在与云端双向同步...';
  } else if (AppState.syncStatus === 'error') {
    dot.classList.add('error');
    text.textContent = '云端同步异常，请检查 Token';
  } else {
    text.textContent = '未绑定云端同步';
    if (bindForm) bindForm.style.display = 'flex';
    if (infoBox) infoBox.style.display = 'none';
    if (syncNowBtn) syncNowBtn.style.display = 'none';
  }
}

// 连接并自动寻找或新建 Gist
async function connectAndSyncGist(token) {
  AppState.syncStatus = 'syncing';
  updateSyncUI();

  // 1. 验证 Token 并列出用户的 Gists，寻找是否已有 novel_read_status.json
  const listResp = await fetch('https://api.github.com/gists?per_page=100', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!listResp.ok) {
    throw new Error(listResp.status === 401 ? 'Token 无效或已过期' : `GitHub API 错误 (${listResp.status})`);
  }

  const gists = await listResp.json();
  let targetGist = gists.find(g => g.files && g.files['novel_read_status.json']);

  // 2. 如果不存在，自动创建一个私有的 Gist
  if (!targetGist) {
    const createData = {
      readStatus: serializeReadStatus(),
      recentCopies: AppState.recentCopies,
      updatedAt: new Date().toISOString()
    };

    const createResp = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        description: '网络小说书库多设备阅读进度同步 [自动生成]',
        public: false,
        files: {
          'novel_read_status.json': {
            content: JSON.stringify(createData, null, 2)
          }
        }
      })
    });

    if (!createResp.ok) {
      throw new Error(`创建 Gist 失败 (${createResp.status})，请确保 Token 勾选了 gist 权限`);
    }

    targetGist = await createResp.json();
  }

  // 3. 存储并初始化
  AppState.ghToken = token;
  AppState.gistId = targetGist.id;
  localStorage.setItem(STORAGE_KEYS.GH_TOKEN, token);
  localStorage.setItem(STORAGE_KEYS.GIST_ID, targetGist.id);
  localStorage.setItem(STORAGE_KEYS.LAST_SYNC, Date.now().toString());

  // 4. 双向拉取并合并
  await syncGist(true);
}

// 双向同步逻辑（拉取云端 -> 智能合并 -> 回写云端）
async function syncGist(isInitial = false) {
  if (!AppState.ghToken || !AppState.gistId) return;

  AppState.syncStatus = 'syncing';
  updateSyncUI();

  try {
    const getResp = await fetch(`https://api.github.com/gists/${AppState.gistId}?t=${Date.now()}`, {
      headers: {
        'Authorization': `Bearer ${AppState.ghToken}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!getResp.ok) throw new Error(`拉取 Gist 失败: HTTP ${getResp.status}`);
    const gist = await getResp.json();
    const file = gist.files && gist.files['novel_read_status.json'];

    if (file && file.content) {
      try {
        const remoteData = JSON.parse(file.content);
        const remoteTime = remoteData.updatedAt
          ? (typeof remoteData.updatedAt === 'number' ? remoteData.updatedAt : new Date(remoteData.updatedAt).getTime())
          : 0;
        const localTime = AppState.statusModifiedAt || 0;

        // 仅当云端时间明显晚于本地修改时间（说明用户在另一台设备上操作了）时，才用云端覆盖本地
        if (remoteTime > localTime + 1000) {
          if (remoteData.readStatus) {
            AppState.readStatus = {};
            for (const [bookId, chapters] of Object.entries(remoteData.readStatus)) {
              AppState.readStatus[bookId] = new Set(Array.isArray(chapters) ? chapters : []);
            }
            AppState.statusModifiedAt = remoteTime;
            localStorage.setItem(STORAGE_KEYS.STATUS_MODIFIED_AT, remoteTime.toString());
            saveReadStatus(false);
          }
        }
      } catch (parseErr) {
        console.warn('解析云端 Gist JSON 失败:', parseErr);
      }
    }

    // 回写最新的本地状态到 Gist（确保撤销操作第一时间同步到云端）
    const payload = {
      readStatus: serializeReadStatus(),
      updatedAt: AppState.statusModifiedAt || Date.now()
    };

    await fetch(`https://api.github.com/gists/${AppState.gistId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${AppState.ghToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        files: {
          'novel_read_status.json': {
            content: JSON.stringify(payload, null, 2)
          }
        }
      })
    });

    AppState.syncStatus = 'connected';
    localStorage.setItem(STORAGE_KEYS.LAST_SYNC, Date.now().toString());
    updateSyncUI();

    // 重新渲染当前视图
    renderChapterStats();
    renderChapterList();
    renderBookList();
  } catch (err) {
    console.error('Gist 同步失败:', err);
    AppState.syncStatus = 'error';
    updateSyncUI();
    if (!isInitial) throw err;
  }
}

// 辅助序列化
function serializeReadStatus() {
  const serialized = {};
  for (const [k, v] of Object.entries(AppState.readStatus)) {
    serialized[k] = Array.from(v);
  }
  return serialized;
}

// 快速防抖静默推送（缩短至 250ms，并在页面关闭/刷新前立即触发）
function triggerDebouncedGistSync() {
  if (!AppState.ghToken || !AppState.gistId) return;

  if (AppState.syncTimer) clearTimeout(AppState.syncTimer);
  AppState.syncTimer = setTimeout(() => {
    syncGist(false).catch(e => console.warn('后台防抖同步失败:', e));
  }, 250);
}

window.addEventListener('beforeunload', () => {
  if (AppState.syncTimer) {
    clearTimeout(AppState.syncTimer);
    syncGist(false).catch(() => {});
  }
});
