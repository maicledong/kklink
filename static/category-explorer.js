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
    expandedPaths: {explorer: new Set(),picker: new Set(),movePicker: new Set()},   // 分别记录资源管理器和保存区选择器的展开状态
    movePickerPath: "/default"
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

  // ============================================================
// 重命名后同步树的展开状态
// ============================================================

function renameExpandedPaths(oldPath, newPath) {

    const updateSet = (expandedSet) => {

        if (!(expandedSet instanceof Set)) {
            return;
        }

        const updated = new Set();

        for (const path of expandedSet) {

            // 当前展开节点就是被重命名的分类
            if (path === oldPath) {
                updated.add(newPath);
                continue;
            }

            // 当前展开节点是被重命名分类的后代
            if (path.startsWith(oldPath + "/")) {
                updated.add(
                    newPath + path.slice(oldPath.length)
                );
                continue;
            }

            // 不属于被重命名分类的路径，保持不变
            updated.add(path);
        }

        // 替换原来的 Set 内容
        expandedSet.clear();

        for (const path of updated) {
            expandedSet.add(path);
        }
    };

    // 分别迁移资源管理器、保存区、移动选择器的展开状态
    updateSet(CategoryStore.expandedPaths.explorer);
    updateSet(CategoryStore.expandedPaths.picker);
    updateSet(CategoryStore.expandedPaths.movePicker);
}

  function getChildren(path) {
    return CategoryStore.byParent[path] || [];
  }

  // ---------- 树渲染 ----------
  function renderTreeInto(container, mode) {
    // mode: "explorer" | "picker"
    if (!container) return;
    container.innerHTML = "";
    // 获取根分类，并确保“默认”始终排在第一个
    const roots = getChildren("/").slice();
    roots.sort((a, b) => {
      if (a.path === "/default") return -1;
      if (b.path === "/default") return 1;
      return 0;
    });
    
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
if (
    mode === "explorer" &&
    CategoryStore.currentPath === node.path
) {
    row.classList.add("bg-blue-600/20", "text-blue-300");
}

if (
    mode === "picker" &&
    CategoryStore.pickerPath === node.path
) {
    row.classList.add("bg-blue-600/20", "text-blue-300");
}

if (
    mode === "movePicker" &&
    CategoryStore.movePickerPath === node.path
) {
    row.classList.add("bg-blue-600/20", "text-blue-300");
}

    const hasChildren = node.has_children || (node.child_count || 0) > 0;
const toggle = document.createElement("span");
toggle.className = "cat-toggle w-4 flex items-center justify-center text-slate-400 select-none";

if (hasChildren) {
  toggle.dataset.toggle = "1";
  toggle.innerHTML = `
    <svg viewBox="0 0 24 24" class="tree-arrow">
      <path d="M8 5l8 7-8 7"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"/>
    </svg>
  `;
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
      moreBtn.textContent = "⋯";
      moreBtn.dataset.more = "1";
      row.appendChild(moreBtn);
    }

    wrap.appendChild(row);

    // 子容器
    const childBox = document.createElement("div");
    childBox.className = "cat-children hidden pl-4";
    wrap.appendChild(childBox);


// 恢复之前记录的展开状态
const expandedSet = CategoryStore.expandedPaths[mode];

if (expandedSet && expandedSet.has(node.path)) {
    const children = getChildren(node.path);

    for (const c of children) {
        childBox.appendChild(createTreeNode(c, mode));
    }

    if (children.length > 0) {
        childBox.classList.remove("hidden");

        const arrow = toggle.querySelector(".tree-arrow");
        if (arrow) {
            arrow.style.transform = "rotate(90deg)";
        }
    }
}    

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

    // 保存区选择分类
    CategoryStore.pickerPath = node.path;

    renderTreeInto(
        document.getElementById("categoryPickerTree"),
        "picker"
    );

    closePickerDropdown();
    updatePickerBadge(node);

} else if (mode === "movePicker") {

    // 移动链接时选择目标分类
    CategoryStore.movePickerPath = node.path;

closeMoveCategoryPicker(node.path);

} else {

    // 资源管理器选择分类
    selectCategory(node.path);
}
    });

    return wrap;
  }

function toggleNode(wrap, node, childBox, mode) {
    const expandedSet = CategoryStore.expandedPaths[mode];

    if (!expandedSet) return;

    const isExpanded = expandedSet.has(node.path);

    const arrow = wrap.querySelector(".tree-arrow");

    if (isExpanded) {
        // 当前已经展开：只折叠当前分类
        expandedSet.delete(node.path);

        childBox.classList.add("hidden");

        if (arrow) {
            arrow.style.transform = "rotate(0deg)";
        }

    } else {
        // 当前处于折叠状态：展开当前分类
        const children = getChildren(node.path);

        if (children.length === 0) return;

        expandedSet.add(node.path);

        // 如果子分类还没有生成，则生成一次
        if (childBox.childElementCount === 0) {
            for (const c of children) {
                childBox.appendChild(createTreeNode(c, mode));
            }
        }

        childBox.classList.remove("hidden");

        if (arrow) {
            arrow.style.transform = "rotate(90deg)";
        }
    }
}

// ---------- ··· 菜单 ----------
let moreMenuEl = null;

function openMoreMenu(btn, node, mode) {

    // 再次点击同一个按钮：关闭菜单
    if (
        moreMenuEl &&
        moreMenuEl.dataset.triggerPath === node.path
    ) {
        closeMoreMenu();
        return;
    }

    // 打开新菜单前，先关闭之前的菜单
    closeMoreMenu();

    const menu = document.createElement("div");

    menu.className = `
        fixed z-[100001]
        bg-slate-800 border border-slate-700
        rounded-lg shadow-xl p-1
        w-[120px] min-w-[120px]
        max-h-[calc(100vh-16px)]
        overflow-y-auto
    `;

    menu.dataset.triggerPath = node.path;

    menu.innerHTML = `
        <button data-act="add"
            class="w-full text-left px-2.5 py-1.5 text-[13px] rounded hover:bg-slate-700 text-slate-200">
            ➕ 子列表
        </button>

        <button data-act="rename"
            class="w-full text-left px-2.5 py-1.5 text-[13px] rounded hover:bg-slate-700 text-slate-200">
            ✏️ 重命名
        </button>

        <button data-act="delete"
            class="w-full text-left px-2.5 py-1.5 text-[13px] rounded hover:bg-red-600/20 text-red-400">
            🗑️ 删除
        </button>
    `;

    // 限制菜单尺寸，防止手机屏幕太窄或太矮时越界
    menu.style.maxWidth = "calc(100vw - 16px)";
    menu.style.maxHeight = "calc(100vh - 16px)";

    document.body.appendChild(menu);
    moreMenuEl = menu;

    // ---------- 自动计算菜单位置 ----------
    const rect = btn.getBoundingClientRect();

    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;

    const margin = 8;
    const gap = 4;

    // 水平方向：优先与按钮右侧对齐
    let left = rect.left - menuWidth;

    const maxLeft = Math.max(
        margin,
        window.innerWidth - menuWidth - margin
    );

    left = Math.max(margin, Math.min(left, maxLeft));

    // 垂直方向：优先显示在按钮下方
    let top;

    if (
        rect.bottom + gap + menuHeight <=
        window.innerHeight - margin
    ) {
        top = rect.bottom + gap;
    } else {
        // 下方空间不足，显示在按钮上方
        top = rect.top - menuHeight - gap;
    }

    // 最终限制在屏幕范围内
    const maxTop = Math.max(
        margin,
        window.innerHeight - menuHeight - margin
    );

    top = Math.max(margin, Math.min(top, maxTop));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    // ---------- 菜单操作 ----------
    menu.addEventListener("click", (e) => {
        const act = e.target.closest("[data-act]")?.dataset.act;
        if (!act) return;

        closeMoreMenu();

        if (act === "add") {
            openCategoryEdit({
                mode: "create",
                parentPath: node.path
            });
        } else if (act === "rename") {
            openCategoryEdit({
                mode: "rename",
                node
            });
        } else if (act === "delete") {
            openCategoryDelete(node);
        }
    });
}

// ---------- 关闭操作菜单 ----------
function closeMoreMenu() {
    if (moreMenuEl) {
        moreMenuEl.remove();
        moreMenuEl = null;
    }
}

// ---------- 统一管理操作菜单的显示与隐藏 ----------
function handleGlobalMoreMenuClick(e) {
    if (!(e.target instanceof Element)) return;

    const target = e.target;

    // ---------- 蓝色选择分类下拉树 ----------
const pickerDropdown = document.getElementById("categoryPickerDropdown");
const pickerBtn = document.getElementById("categoryPickerBtn");

    // 点击分类选择区域以外的位置，关闭下拉树
    if (
        pickerDropdown &&
        !pickerDropdown.contains(target) &&
        !pickerBtn?.contains(target)
    ) {
        closePickerDropdown();
    }

    // ---------- 批量操作菜单 ----------
    const batchMenu = document.getElementById("batchActionMenu");
    const isBatchBtn = target.closest('.toolbar-btn[title="批量操作"]');

    if (batchMenu && !batchMenu.contains(target) && !isBatchBtn) {
        batchMenu.remove();
    }

    // ---------- 分类树 ··· 菜单 ----------
    if (!moreMenuEl) return;

    // 点击当前分类菜单内部，不关闭
    if (moreMenuEl.contains(target)) return;

    // 点击任意分类“···”按钮，交给按钮自己的逻辑处理
    if (target.closest("[data-more]")) return;

    // 点击其他位置或其他按钮，关闭分类菜单
    closeMoreMenu();
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

    if (!name) {
        alert("请输入分类名称");
        return;
    }

    if (name.includes("/")) {
        alert("名称不能包含 /");
        return;
    }

    const confirmBtn = document.getElementById("categoryEditConfirm");
    confirmBtn.disabled = true;

    try {
        if (editContext.mode === "create") {

            // =========================
            // 新建分类
            // =========================
            const createResult = await apiJson("/api/categories/create", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    parent_path: editContext.parentPath,
                    name
                }),
            });
          if (!createResult?.success || !createResult?.path) {
            throw new Error("创建分类接口没有返回有效的创建结果");}

        } else {

            // =========================
            // 重命名分类
            // =========================
            const oldPath = editContext.node.path;

            const renameResult = await apiJson("/api/categories/rename", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    old_path: oldPath,
                    new_name: name
                }),
            });

            const newPath = renameResult?.new_path;

            if (!renameResult?.success || !newPath) {
                throw new Error("重命名接口没有返回有效的新路径");
            }

            // 将路径及其所有后代路径同步更新
            const updatePath = (currentPath) => {
                if (!currentPath) return currentPath;

                if (currentPath === oldPath) {
                    return newPath;
                }

                if (currentPath.startsWith(oldPath + "/")) {
                    return newPath + currentPath.slice(oldPath.length);
                }

                return currentPath;
            };

// 更新资源管理器当前路径
CategoryStore.currentPath = updatePath(
    CategoryStore.currentPath
);

// 更新保存区当前选择路径
CategoryStore.pickerPath = updatePath(
    CategoryStore.pickerPath
);

// 更新移动分类选择器当前路径
CategoryStore.movePickerPath = updatePath(
    CategoryStore.movePickerPath
);

// 同步所有分类树的展开状态
// 必须在 invalidateTree() 之前执行
renameExpandedPaths(oldPath, newPath);

// 通知 index 同步 AppState.category
if (typeof window.onCategoryRenamed === "function") {
    window.onCategoryRenamed({
        old_path: oldPath,
        new_path: newPath
    });
}
        }

        // 刷新分类树
        invalidateTree();

        await loadCategoryTree(true);

        renderExplorerTree();
        renderPickerTree();

// 如果移动分类弹窗正打开，同步刷新移动树
const moveTree = document.getElementById("moveCategoryPickerTree");

if (moveTree) {
    renderTreeInto(moveTree, "movePicker");
}

        // 刷新保存区的分类徽标
        const pickerNode = CategoryStore.treeCache.find(
            node => node.path === CategoryStore.pickerPath
        );

        updatePickerBadge(pickerNode);

        closeCategoryEdit();

    } catch (e) {
        console.error("分类操作失败：", e);
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
    const deletedPath = deleteContext.path;

    confirmBtn.disabled = true;

    try {
        const r = await apiJson("/api/categories/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: deletedPath }),
        });

        // 确认接口确实删除成功，并且返回的是本次删除路径
        if (!r?.success || r.path !== deletedPath) {
            throw new Error("删除接口没有返回有效的删除结果");
        }

        // 删除成功后，清理失效路径和展开状态
        cleanupDeletedCategoryState(deletedPath);

        // 刷新分类树
        invalidateTree();
        await loadCategoryTree(true);

        renderExplorerTree();
        renderPickerTree();

        // 如果移动分类弹窗正打开，也同步刷新它
        const moveTree = document.getElementById("moveCategoryPickerTree");
        if (moveTree) {
            renderTreeInto(moveTree, "movePicker");
        }

        // 更新保存区分类徽标
        const pickerNode = CategoryStore.treeCache.find(
            node => node.path === CategoryStore.pickerPath
        );

        updatePickerBadge(pickerNode);

        closeCategoryDelete();

        // 通知 index 更新 AppState.category
        if (typeof window.onCategoryDeleted === "function") {
            window.onCategoryDeleted(r);
        }

    } catch (e) {
        console.error("删除分类失败：", e);
        alert(e.message || "删除失败");
    } finally {
        confirmBtn.disabled = false;
    }
}


// 删除分类后，清理所有指向已删除分类及其后代的状态
function cleanupDeletedCategoryState(deletedPath) {

    const isInsideDeletedTree = (currentPath) => {
        return currentPath === deletedPath ||
            currentPath.startsWith(deletedPath + "/");
    };

    // 清理资源管理器当前路径
    if (isInsideDeletedTree(CategoryStore.currentPath)) {
        CategoryStore.currentPath = "/default";
    }

    // 清理保存区选择路径
    if (isInsideDeletedTree(CategoryStore.pickerPath)) {
        CategoryStore.pickerPath = "/default";
    }

    // 清理移动选择器路径
    if (isInsideDeletedTree(CategoryStore.movePickerPath)) {
        CategoryStore.movePickerPath = "/default";
    }

    // 清理三棵树的展开状态
    for (const expandedSet of Object.values(CategoryStore.expandedPaths)) {
        if (!(expandedSet instanceof Set)) continue;

        for (const expandedPath of expandedSet) {
            if (isInsideDeletedTree(expandedPath)) {
                expandedSet.delete(expandedPath);
            }
        }
    }
}


  

  function closeCategoryDelete() {
    document.getElementById("categoryDeleteModal").classList.add("hidden");
    deleteContext = null;
  }

  // ---------- 选中分类 ----------
  function selectCategory(path) {
    CategoryStore.currentPath = path;
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
      btn.classList.toggle("text-blue-500", active);
      btn.classList.toggle("border-blue-500", active);
      btn.classList.toggle("text-slate-400", !active);
      btn.classList.toggle("border-transparent", !active);
      btn.classList.remove("bg-blue-600", "text-white", "bg-blue-500");
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
}

  function closePickerDropdown() {
    document.getElementById("categoryPickerDropdown")?.classList.add("hidden");
  }

// ============================================================
// 移动链接专用分类选择器
// ============================================================

let movePickerResolve = null;

function openMoveCategoryPicker() {

    const modal = document.createElement("div");

    modal.id = "moveCategoryPickerModal";

    modal.className = `
        fixed inset-0 z-[100002]
        flex items-center justify-center
        bg-black/60 p-4
    `;

    modal.innerHTML = `
        <div class="
            w-full max-w-md
            max-h-[85vh]
            flex flex-col
            rounded-xl border border-slate-700
            bg-slate-900 shadow-2xl
        ">
            <div class="
                flex items-center justify-between
                px-4 py-3 border-b border-slate-700
            ">
                <div class="text-white font-semibold">
                    选择目标分类
                </div>

                <button
                    type="button"
                    data-move-picker-close
                    class="text-slate-400 hover:text-white text-xl"
                >×</button>
            </div>

            <div class="px-4 py-2 text-xs text-slate-400">
                点击分类名称即可选择；点击左侧箭头可以展开或折叠子分类。
            </div>

            <div
                id="moveCategoryPickerTree"
                class="overflow-y-auto flex-1 min-h-0 px-3 py-2"
            ></div>

            <div class="
                px-4 py-3 border-t border-slate-700
                flex justify-end
            ">
                <button
                    type="button"
                    data-move-picker-close
                    class="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm"
                >取消</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    CategoryStore.movePickerPath = "/default";

    renderTreeInto(
        document.getElementById("moveCategoryPickerTree"),
        "movePicker"
    );

    modal.querySelectorAll("[data-move-picker-close]").forEach(btn => {
        btn.addEventListener("click", () => {
            closeMoveCategoryPicker(null);
        });
    });

    modal.addEventListener("click", (e) => {
        if (e.target === modal) {
            closeMoveCategoryPicker(null);
        }
    });

    modal._escHandler = (e) => {
        if (e.key === "Escape") {
            closeMoveCategoryPicker(null);
        }
    };

    document.addEventListener("keydown", modal._escHandler);
}

function closeMoveCategoryPicker(result = null) {

    const modal = document.getElementById("moveCategoryPickerModal");

    if (modal) {
        if (modal._escHandler) {
            document.removeEventListener(
                "keydown",
                modal._escHandler
            );
        }

        modal.remove();
    }

    const resolve = movePickerResolve;
    movePickerResolve = null;

    if (resolve) {
        resolve(result);
    }
}

async function chooseMoveCategory() {

    // 确保分类树已经加载
    await loadCategoryTree();

    // 关闭可能存在的旧弹窗
    closeMoveCategoryPicker(null);

    return new Promise((resolve) => {

        movePickerResolve = resolve;

        openMoveCategoryPicker();
    });
}

  // ---------- 保存区展开/折叠 ----------
  function toggleSaveZone() {
    const explorer = document.getElementById("explorerView");
    const toggleBtn = document.getElementById("toggleSaveZoneBtn");
    const inputWrapper = document.getElementById("inputWrapper");
    const scopeTabsWrapper = document.getElementById("scopeTabsWrapper"); // 🌟 新增获取 scopeTabs 的包裹层

    if (!explorer || !inputWrapper) return;
    
    const isHidden = explorer.classList.contains("hidden");
    
    if (isHidden) {
      // 展开
      explorer.classList.remove("hidden");
      explorer.classList.add("flex"); 
      
      // 输入框靠左
      inputWrapper.classList.remove("mx-auto", "max-w-2xl");
      inputWrapper.classList.add("max-w-[600px]");

      // 🌟 Scope 按钮组也一起靠左
      if (scopeTabsWrapper) {
        scopeTabsWrapper.classList.remove("mx-auto", "max-w-2xl", "pl-[60px]");
        scopeTabsWrapper.classList.add("max-w-[600px]");
        scopeTabsWrapper.style.paddingLeft = "60px";
      }
      
      if (toggleBtn) {
        toggleBtn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M20 12H4"></path></svg>`;
      }
      
      loadCategoryTree().then(() => {
        renderExplorerTree();
        renderPickerTree();
      }).catch((e) => console.error("加载分类树失败", e));
      
    } else {
      // 折叠
      explorer.classList.add("hidden");
      explorer.classList.remove("flex");
      
      // 输入框恢复居中
      inputWrapper.classList.remove("max-w-[600px]");
      inputWrapper.classList.add("mx-auto", "max-w-2xl");

      // 🌟 Scope 按钮组恢复居中
      if (scopeTabsWrapper) {
        scopeTabsWrapper.classList.remove("max-w-[600px]");
        scopeTabsWrapper.classList.add("mx-auto", "max-w-2xl", "pl-[60px]");
        scopeTabsWrapper.style.paddingLeft = "";
      }
      
      if (toggleBtn) {
        toggleBtn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M12 4v16m8-8H4"></path></svg>`;
      }
    }
  }

  // ---------- 更新保存区蓝色按钮上的悬浮徽标 ----------
  function updatePickerBadge(node) {
    const btnWrapper = document.getElementById("categoryPickerBtn")?.parentElement;
    if (!btnWrapper) return;

    // 查找是否已经有徽标元素
    let badge = btnWrapper.querySelector(".picker-badge");
    
    // 如果是默认分类，或者没传 node，就隐藏徽标
    if (!node || node.path === "/default" || node.is_system) {
      if (badge) badge.remove();
      return;
    }

    // 如果没有，就创建一个
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "picker-badge absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap px-2 py-0.5 bg-blue-600 text-white text-xs rounded shadow-lg z-[10000] pointer-events-none transition-opacity duration-200";
      // 加一个小三角指向下方
      badge.innerHTML = `
        <span class="badge-text"></span>
        <div class="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-blue-600"></div>
      `;
      btnWrapper.appendChild(badge);
    }

    // 更新文字
    const textSpan = badge.querySelector(".badge-text");
    if (textSpan) {
      textSpan.textContent = node.name;
    }
    
    // 动画效果：闪一下
    badge.style.opacity = "0";
    setTimeout(() => { badge.style.opacity = "1"; }, 50);
  }
  

  // ---------- 事件绑定 ----------
  function bindEvents() {
     // 全局统一管理操作菜单（捕获阶段监听）
    document.addEventListener("click", handleGlobalMoreMenuClick, true); 
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

    openMoveCategoryPicker,
    closeMoveCategoryPicker,
    chooseMoveCategory,

    getCurrentPath: () => CategoryStore.currentPath,
    getPickerPath: () => CategoryStore.pickerPath,
    getScope: () => CategoryStore.scope,

    setCurrentPath: (p) => {
        CategoryStore.currentPath = p;
        renderExplorerTree();
    },

    setPickerPath: (p) => {
        CategoryStore.pickerPath = p;
        renderPickerTree();

        const node = CategoryStore.treeCache?.find(
            item => item.path === p
        );

        updatePickerBadge(node);
    },
};

  // ---------- 初始化 ----------
  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    
    // 预加载树
    loadCategoryTree().then(() => {
       // 如果 pickerPath 不是 default，恢复徽标
       if (CategoryStore.pickerPath && CategoryStore.pickerPath !== "/default") {
           // 从缓存里找出这个节点
           const node = CategoryStore.treeCache.find(n => n.path === CategoryStore.pickerPath);
           if (node) updatePickerBadge(node);
       }
    }).catch(() => {});
  });
})();
