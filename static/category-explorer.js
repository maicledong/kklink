/* ============================================================
 * 分类资源管理器（第 3 批：树 + 选择器 + 新建/重命名/删除）
 * 依赖：/api/categories/tree /create /rename /delete
 * ============================================================ */

(function () {
  "use strict";

  // ---------- 状态 ----------
  const CategoryStore = {
    treeCache: null,          // null = 未加载；数组 = 已加载
    byParent: {},             // { "/": [...], "/工作": [...] }
    currentPath: "/default",  // 资源管理器当前分类
    pickerPath: "/default",   // 保存区选中的分类
    scope: "home",            // home | fav | archive | category
    loading: false,
  };

  // ---------- 工具 ----------
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  async function apiJson(url, opts) {
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const msg = data?.error || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  // ---------- 树数据 ----------
  async function loadCategoryTree(force = false) {
    if (!force && CategoryStore.treeCache) return CategoryStore.treeCache;
    const data = await apiJson("/api/categories/tree");
    CategoryStore.treeCache = data.data || [];
    const byParent = {};
    for (const node of CategoryStore.treeCache) {
      const p = node.parent_path || "/";
      (byParent[p] ||= []).push(node);
    }
    CategoryStore.byParent = byParent;
    return CategoryStore.treeCache;
  }

  function invalidateTree() {
    CategoryStore.treeCache = null;
    CategoryStore.byParent = {};
  }

  function getChildren(path) {
    return CategoryStore.byParent[path] || [];
  }

  // ---------- 树渲染 ----------
  function renderTreeInto(container, mode) {
    // mode: "explorer" | "picker"
    if (!container) return;
    container.innerHTML = "";
    const roots = getChildren("/");
    if (roots.length === 0) {
      container.innerHTML = `<div class="text-slate-500 text-xs px-2 py-3">暂无分类</div>`;
      return;
    }
    for (const node of roots) {
      container.appendChild(createTreeNode(node, mode));
    }
  }

  function createTreeNode(node, mode) {
    const wrap = document.createElement("div");
    wrap.className = "cat-node";
    wrap.dataset.path = node.path;

    const row = document.createElement("div");
    row.className = "cat-row flex items-center gap-1 px-2 py-1.5 rounded cursor-pointer hover:bg-slate-700/60 transition-colors";
    if (mode === "explorer" && CategoryStore.currentPath === node.path) {
      row.classList.add("bg-blue-600/20", "text-blue-300");
    }
    if (mode === "picker" && CategoryStore.pickerPath === node.path) {
      row.classList.add("bg-blue-600/20", "text-blue-300");
    }

    const hasChildren = node.has_children || (node.child_count || 0) > 0;
    const toggle = document.createElement("span");
    toggle.className = "cat-toggle w-4 text-center text-slate-400 select-none";
    toggle.textContent = hasChildren ? "▶" : "";
    if (hasChildren) {
      toggle.dataset.toggle = "1";
    }

    const icon = document.createElement("span");
    icon.textContent = node.is_system ? "🔒" : "📁";
    icon.className = "text-sm";

    const name = document.createElement("span");
    name.className = "cat-name flex-1 truncate text-sm";
    name.textContent = node.name;
    name.title = node.path;

    row.appendChild(toggle);
    row.appendChild(icon);
    row.appendChild(name);

    // 右侧 ··· 操作（仅 explorer 模式 + 非系统分类）
    if (mode === "explorer" && !node.is_system) {
      const moreBtn = document.createElement("button");
      moreBtn.className = "cat-more text-slate-400 hover:text-white px-1";
      moreBtn.textContent = "···";
      moreBtn.dataset.more = "1";
      row.appendChild(moreBtn);
    }

    wrap.appendChild(row);

    // 子容器
    const childBox = document.createElement("div");
    childBox.className = "cat-children hidden pl-4";
    wrap.appendChild(childBox);

    // 展开/折叠
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-toggle]")) {
        e.stopPropagation();
        toggleNode(wrap, node, childBox, mode);
        return;
      }
      if (e.target.closest("[data-more]")) {
        e.stopPropagation();
        openMoreMenu(e.target.closest("[data-more]"), node, mode);
        return;
      }
      // 点击行
      if (mode === "picker") {
        CategoryStore.pickerPath = node.path;
        renderTreeInto(document.getElementById("categoryPickerTree"), "picker");
        closePickerDropdown();
      } else {
        selectCategory(node.path);
      }
    });

    return wrap;
  }

  function toggleNode(wrap, node, childBox, mode) {
    const isHidden = childBox.classList.contains("hidden");
    if (isHidden && childBox.childElementCount === 0) {
      const children = getChildren(node.path);
      if (children.length === 0) {
        childBox.classList.add("hidden");
        return;
      }
      for (const c of children) {
        childBox.appendChild(createTreeNode(c, mode));
      }
    }
    childBox.classList.toggle("hidden", !isHidden);
    const toggle = wrap.querySelector(".cat-toggle");
    if (toggle) toggle.textContent = isHidden ? "▼" : "▶";
  }

  // ---------- ··· 菜单 ----------
  let moreMenuEl = null;
  function openMoreMenu(btn, node, mode) {
    closeMoreMenu();
    const menu = document.createElement("div");
    menu.className = "fixed z-[100001] bg-slate-800 border border-slate-700 rounded-lg shadow-xl p-1 min-w-[140px]";
    menu.innerHTML = `
      <button data-act="add" class="w-full text-left px-3 py-2 text-sm rounded hover:bg-slate-700 text-slate-200">＋ 新建子列表</button>
      <button data-act="rename" class="w-full text-left px-3 py-2 text-sm rounded hover:bg-slate-700 text-slate-200">✏️ 重命名</button>
      <button data-act="delete" class="w-full text-left px-3 py-2 text-sm rounded hover:bg-red-600/20 text-red-400">🗑️ 删除</button>
    `;
    document.body.appendChild(menu);
    const rect = btn.getBoundingClientRect();
    menu.style.left = Math.min(rect.left, window.innerWidth - 160) + "px";
    menu.style.top = (rect.bottom + 4) + "px";

    menu.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      closeMoreMenu();
      if (act === "add") openCategoryEdit({ mode: "create", parentPath: node.path });
      else if (act === "rename") openCategoryEdit({ mode: "rename", node });
      else if (act === "delete") openCategoryDelete(node);
    });

    moreMenuEl = menu;
    setTimeout(() => {
      document.addEventListener("click", onDocClickCloseMore, { once: true });
    }, 0);
  }
  function onDocClickCloseMore(e) {
    if (moreMenuEl && !moreMenuEl.contains(e.target)) closeMoreMenu();
  }
  function closeMoreMenu() {
    if (moreMenuEl) {
      moreMenuEl.remove();
      moreMenuEl = null;
    }
  }

  // ---------- 分类编辑弹窗 ----------
  let editContext = null;
  function openCategoryEdit(ctx) {
    editContext = ctx;
    const modal = document.getElementById("categoryEditModal");
    const title = document.getElementById("categoryEditTitle");
    const parentEl = document.getElementById("categoryEditParent");
    const input = document.getElementById("categoryEditInput");
    if (ctx.mode === "create") {
      title.textContent = "新建分类";
      parentEl.textContent = `父分类：${ctx.parentPath === "/" ? "根目录" : ctx.parentPath}`;
      input.value = "";
    } else {
      title.textContent = "重命名分类";
      parentEl.textContent = `原路径：${ctx.node.path}`;
      input.value = ctx.node.name;
    }
    modal.classList.remove("hidden");
    setTimeout(() => input.focus(), 50);
  }

  async function submitCategoryEdit() {
    if (!editContext) return;
    const input = document.getElementById("categoryEditInput");
    const name = input.value.trim();
    if (!name) { alert("请输入分类名称"); return; }
    if (name.includes("/")) { alert("名称不能包含 /"); return; }

    const confirmBtn = document.getElementById("categoryEditConfirm");
    confirmBtn.disabled = true;
    try {
      if (editContext.mode === "create") {
        await apiJson("/api/categories/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parent_path: editContext.parentPath, name }),
        });
      } else {
        await apiJson("/api/categories/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ old_path: editContext.node.path, new_name: name }),
        });
      }
      invalidateTree();
      await loadCategoryTree(true);
      renderExplorerTree();
      renderPickerTree();
      closeCategoryEdit();
    } catch (e) {
      alert(e.message || "操作失败");
    } finally {
      confirmBtn.disabled = false;
    }
  }

  function closeCategoryEdit() {
    document.getElementById("categoryEditModal").classList.add("hidden");
    editContext = null;
  }

  // ---------- 删除分类 ----------
  let deleteContext = null;
  function openCategoryDelete(node) {
    deleteContext = node;
    const modal = document.getElementById("categoryDeleteModal");
    const msg = document.getElementById("categoryDeleteMsg");
    msg.innerHTML = `确定删除分类 <b class="text-red-400">${escapeHtml(node.name)}</b>？<br><span class="text-red-400">该分类下的子分类和所有链接将一并删除，不可恢复。</span>`;
    modal.classList.remove("hidden");
  }

  async function submitCategoryDelete() {
    if (!deleteContext) return;
    const confirmBtn = document.getElementById("categoryDeleteConfirm");
    confirmBtn.disabled = true;
    try {
      const r = await apiJson("/api/categories/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: deleteContext.path }),
      });
      invalidateTree();
      await loadCategoryTree(true);
      renderExplorerTree();
      renderPickerTree();
      closeCategoryDelete();
      if (typeof window.onCategoryDeleted === "function") {
        window.onCategoryDeleted(r);
      }
    } catch (e) {
      alert(e.message || "删除失败");
    } finally {
      confirmBtn.disabled = false;
    }
  }

  function closeCategoryDelete() {
    document.getElementById("categoryDeleteModal").classList.add("hidden");
    deleteContext = null;
  }

  // ---------- 选中分类 ----------
  function selectCategory(path) {
    CategoryStore.currentPath = path;
    // scope 自动切到 category
    setScope("category", { silent: true });
    renderExplorerTree();
    // 通知外部（第 4 批接卡片列表）
    if (typeof window.onCategorySelected === "function") {
      window.onCategorySelected(path);
    }
  }

  // ---------- scope 切换 ----------
  function setScope(scope, { silent = false } = {}) {
    if (!["home", "fav", "archive", "category"].includes(scope)) return;
    CategoryStore.scope = scope;
    // 更新 tab 样式
    document.querySelectorAll("#scopeTabs .scope-tab").forEach((btn) => {
      const active = btn.dataset.scope === scope;
      btn.classList.toggle("bg-blue-600", active);
      btn.classList.toggle("text-white", active);
      btn.classList.toggle("text-slate-300", !active);
      btn.classList.toggle("hover:text-white", !active);
    });
    // 非分类 scope 时，树不高亮
    if (scope !== "category") {
      renderExplorerTree();
    }
    if (!silent && typeof window.onScopeChanged === "function") {
      window.onScopeChanged(scope);
    }
  }

  // ---------- 渲染入口 ----------
  function renderExplorerTree() {
    const container = document.getElementById("categoryTree");
    if (!container) return;
    renderTreeInto(container, "explorer");
  }

  function renderPickerTree() {
    const container = document.getElementById("categoryPickerTree");
    if (!container) return;
    renderTreeInto(container, "picker");
  }

  function openPickerDropdown() {
    const dd = document.getElementById("categoryPickerDropdown");
    if (!dd) return;
    renderPickerTree();
    dd.classList.remove("hidden");
    setTimeout(() => {
      document.addEventListener("click", onDocClickClosePicker, { once: true });
    }, 0);
  }
  function onDocClickClosePicker(e) {
    const dd = document.getElementById("categoryPickerDropdown");
    const btn = document.getElementById("categoryPickerBtn");
    if (!dd || !btn) return;
    if (!dd.contains(e.target) && !btn.contains(e.target)) {
      closePickerDropdown();
    }
  }
  function closePickerDropdown() {
    document.getElementById("categoryPickerDropdown")?.classList.add("hidden");
  }

  // ---------- 保存区展开/折叠 ----------
  function toggleSaveZone() {
    const zone = document.getElementById("saveZone");
    const explorer = document.getElementById("explorerView");
    if (!zone || !explorer) return;
    const willHide = !zone.classList.contains("hidden");
    if (willHide) {
      zone.classList.add("hidden");
      explorer.classList.add("hidden");
    } else {
      zone.classList.remove("hidden");
      explorer.classList.remove("hidden");
      // 首次展开时加载树
      loadCategoryTree().then(() => {
        renderExplorerTree();
        renderPickerTree();
      }).catch((e) => console.error("加载分类树失败", e));
    }
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    // scope tabs
    document.querySelectorAll("#scopeTabs .scope-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        setScope(btn.dataset.scope);
      });
    });

    // 蓝色按钮 -> picker
    document.getElementById("categoryPickerBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const dd = document.getElementById("categoryPickerDropdown");
      if (dd && !dd.classList.contains("hidden")) {
        closePickerDropdown();
      } else {
        openPickerDropdown();
      }
    });

    // picker 下拉里的“新建”
    document.getElementById("pickerAddCategoryBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      openCategoryEdit({ mode: "create", parentPath: CategoryStore.pickerPath || "/" });
    });

    // 资源管理器根“新建”
    document.getElementById("rootAddCategoryBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      openCategoryEdit({ mode: "create", parentPath: "/" });
    });

    // 加号 -> 展开/折叠
    document.getElementById("toggleSaveZoneBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSaveZone();
    });

    // 编辑弹窗
    document.getElementById("categoryEditConfirm")?.addEventListener("click", submitCategoryEdit);
    document.getElementById("categoryEditCancel")?.addEventListener("click", closeCategoryEdit);
    document.getElementById("categoryEditModal")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeCategoryEdit();
    });
    document.getElementById("categoryEditInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitCategoryEdit();
      if (e.key === "Escape") closeCategoryEdit();
    });

    // 删除弹窗
    document.getElementById("categoryDeleteConfirm")?.addEventListener("click", submitCategoryDelete);
    document.getElementById("categoryDeleteCancel")?.addEventListener("click", closeCategoryDelete);
    document.getElementById("categoryDeleteModal")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeCategoryDelete();
    });
  }

  // ---------- 对外 API ----------
  window.CategoryExplorer = {
    CategoryStore,
    loadCategoryTree,
    invalidateTree,
    renderExplorerTree,
    renderPickerTree,
    setScope,
    selectCategory,
    toggleSaveZone,
    openCategoryEdit,
    openPickerDropdown,
    closePickerDropdown,
    getCurrentPath: () => CategoryStore.currentPath,
    getPickerPath: () => CategoryStore.pickerPath,
    getScope: () => CategoryStore.scope,
    setPickerPath: (p) => { CategoryStore.pickerPath = p; },
  };

  // ---------- 初始化 ----------
  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    // 不自动展开，等用户点加号
    // 但可以预加载树（静默）
    loadCategoryTree().catch(() => {});
  });
})();
