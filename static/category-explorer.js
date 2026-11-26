//static/category-explorer.js
/* ============================================================
 * 分类资源管理器（第 3 批：树 + 选择器 + 新建/重命名/删除）
 * 依赖：/api/categories/tree /create /rename /delete
 * ============================================================ */

(function () {
  "use strict";

// ---------- 状态 ----------
const CategoryStore = {
    // 分类树数据缓存
    treeCache: null,

    // 按父级分类建立索引
    byParent: {},

    // 当前分类树是否已经初始化
    loaded: false,

    // 分类数据版本号，每次缓存发生变化时递增
    version: 0,

    // 当前资源管理器所在分类
    currentPath: "/default",

    // 保存区选中的分类
    pickerPath: "/default",

    // 当前 scope
    scope: "home",

    // 分类树加载状态
    loading: false,

  // 当前分类树加载请求的 Promise
  loadPromise: null,

    // 各个分类树独立维护展开状态
    expandedPaths: {
        explorer: new Set(),
        picker: new Set(),
        movePicker: new Set(),
        categoryMovePicker: new Set()
    },

    // 移动书签时选中的目标分类
    movePickerPath: null,
  // 当前准备移动的分类路径
categoryMoveSourcePath: null,

// 移动分类时选中的目标父分类
categoryMovePickerPath: null
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


// ============================================================
// 分类树缓存管理
// ============================================================

// ---------- 重建分类父级索引 ----------
function rebuildCategoryIndex() {

    const byParent = {};

    for (const node of CategoryStore.treeCache || []) {

        const parentPath = node.parent_path || "/";

        (byParent[parentPath] ||= []).push(node);
    }

    CategoryStore.byParent = byParent;
}


// ---------- 初始化或获取分类树缓存 ----------
async function loadCategoryTree(force = false) {

    // 已经有缓存，而且不要求强制刷新
    if (
        !force &&
        CategoryStore.loaded &&
        Array.isArray(CategoryStore.treeCache)
    ) {
        return CategoryStore.treeCache;
    }

    // 如果已经有加载请求，直接共用当前 Promise
    if (CategoryStore.loadPromise) {
        return CategoryStore.loadPromise;
    }

    CategoryStore.loading = true;

    // 创建唯一的加载请求
    const request = (async () => {

        const data = await apiJson("/api/categories/tree");

        CategoryStore.treeCache = Array.isArray(data.data)
            ? data.data
            : [];

        // 重建父级索引
        rebuildCategoryIndex();

        // 标记缓存已经初始化
        CategoryStore.loaded = true;

        // 数据版本递增
        CategoryStore.version++;

        return CategoryStore.treeCache;

    })();

    CategoryStore.loadPromise = request;

    try {

        return await request;

    } finally {

        // 只清理当前请求，避免误清理其他请求
        if (CategoryStore.loadPromise === request) {
            CategoryStore.loadPromise = null;
        }

        CategoryStore.loading = false;
    }
}


// ---------- 使分类缓存失效 ----------
function invalidateTree() {

    CategoryStore.treeCache = null;

    CategoryStore.byParent = {};

    CategoryStore.loaded = false;

    CategoryStore.version++;
}


// ============================================================
// 以下操作只修改前端缓存，不请求服务器
// ============================================================


// ---------- 新增分类到缓存 ----------
function addCategoryToCache(node) {

    if (!CategoryStore.loaded || !Array.isArray(CategoryStore.treeCache)) {
        throw new Error("分类缓存尚未初始化");
    }

    if (!node || !node.path) {
        throw new Error("新增分类数据无效");
    }

    // 防止重复添加
    const exists = CategoryStore.treeCache.some(
        item => item.path === node.path
    );

    if (exists) return;

    // 只向缓存增加这一条分类
    CategoryStore.treeCache.push({
        path: node.path,
        name: node.name,
        parent_path: node.parent_path || "/",
        is_system: !!node.is_system,
        has_children: false,
        child_count: 0
    });

    // 更新父级索引
    rebuildCategoryIndex();

    CategoryStore.version++;
}


// ---------- 更新分类及其后代路径 ----------
function updateCategoryPathInCache(oldPath, newPath, newName = null) {

    if (!CategoryStore.loaded || !Array.isArray(CategoryStore.treeCache)) {
        throw new Error("分类缓存尚未初始化");
    }

    const updatePath = (path) => {

        if (path === oldPath) {
            return newPath;
        }

        if (path.startsWith(oldPath + "/")) {
            return newPath + path.slice(oldPath.length);
        }

        return path;
    };

    for (const node of CategoryStore.treeCache) {

        const oldNodePath = node.path;

        // 不属于当前分类及其后代，不需要修改
        if (
            oldNodePath !== oldPath &&
            !oldNodePath.startsWith(oldPath + "/")
        ) {
            continue;
        }

        // 更新分类路径
        node.path = updatePath(oldNodePath);

        // 更新父级路径
        const lastSlash = node.path.lastIndexOf("/");

        node.parent_path = lastSlash <= 0
            ? "/"
            : node.path.slice(0, lastSlash);

        // 只有被重命名的分类本身需要更新名称
        if (oldNodePath === oldPath && newName !== null) {
            node.name = newName;
        }
    }

    // 重新建立父级索引
    rebuildCategoryIndex();

    CategoryStore.version++;
}


// ---------- 从缓存删除分类及其所有后代 ----------
function removeCategoryFromCache(deletedPath) {

    if (!CategoryStore.loaded || !Array.isArray(CategoryStore.treeCache)) {
        throw new Error("分类缓存尚未初始化");
    }

    const oldLength = CategoryStore.treeCache.length;

    CategoryStore.treeCache = CategoryStore.treeCache.filter(node => {

        return node.path !== deletedPath &&
            !node.path.startsWith(deletedPath + "/");
    });

    // 只有确实删除了数据才更新索引
    if (CategoryStore.treeCache.length !== oldLength) {

        rebuildCategoryIndex();

        CategoryStore.version++;
    }
}


// ---------- 根据缓存重新渲染所有现有分类树 ----------
function renderAllCategoryTrees() {

    // Lists 资源管理器
    renderExplorerTree();

    // 保存区蓝色分类选择树
    renderPickerTree();

    // 移动书签分类选择树
    const moveTree = document.getElementById("moveCategoryPickerTree");

    if (moveTree) {
        renderTreeInto(moveTree, "movePicker");
    }

    // 移动分类选择树
    const categoryMoveTree = document.getElementById(
        "categoryMovePickerTree"
    );

    if (categoryMoveTree) {
        renderTreeInto(
            categoryMoveTree,
            "categoryMovePicker"
        );
    }

    // 更新保存区分类徽标
    const pickerNode = CategoryStore.treeCache?.find(
        node => node.path === CategoryStore.pickerPath
    );

    updatePickerBadge(pickerNode);
}



// ============================================================
// 分类路径变化后，同步各个分类树的展开状态
// ============================================================

function renameExpandedPaths(oldPath, newPath) {

    for (const expandedSet of Object.values(CategoryStore.expandedPaths)) {

        if (!(expandedSet instanceof Set)) continue;

        const updated = new Set();

        for (const path of expandedSet) {

            if (path === oldPath) {

                updated.add(newPath);

            } else if (path.startsWith(oldPath + "/")) {

                updated.add(
                    newPath + path.slice(oldPath.length)
                );

            } else {

                updated.add(path);
            }
        }

        expandedSet.clear();

        for (const path of updated) {
            expandedSet.add(path);
        }
    }
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

// 移动分类选择器的选中状态
if (
    mode === "categoryMovePicker" &&
    CategoryStore.categoryMovePickerPath === node.path
) {
    row.classList.add("bg-blue-600/20", "text-blue-300");
}


// 根据当前缓存索引判断是否存在子分类
const hasChildren = getChildren(node.path).length > 0;

// 移动分类时，禁止选择自身及其后代作为目标父分类
const sourcePath = CategoryStore.categoryMoveSourcePath;

const isInvalidCategoryMoveTarget =
    mode === "categoryMovePicker" &&
    !!sourcePath &&
    (
        node.path === sourcePath ||
        node.path.startsWith(sourcePath + "/")
    );

// 无效目标分类显示为不可选择
if (isInvalidCategoryMoveTarget) {
    row.classList.add("opacity-40", "cursor-not-allowed");
}
    
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

// 移动分类选择器：禁止选择自身及后代
if (
    mode === "categoryMovePicker" &&
    isInvalidCategoryMoveTarget
) {
    e.stopPropagation();
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

    // 只更新选中的目标分类，不立即执行移动
    CategoryStore.movePickerPath = node.path;

    // 刷新分类树的选中状态
    renderTreeInto(
        document.getElementById("moveCategoryPickerTree"),
        "movePicker"
    );

    // 更新左下角显示的分类路径
    updateMoveCategoryPath();

} else if (mode === "categoryMovePicker") {

    // 更新移动分类的目标父分类
    CategoryStore.categoryMovePickerPath = node.path;

    // 刷新选中状态
    renderTreeInto(
        document.getElementById("categoryMovePickerTree"),
        "categoryMovePicker"
    );

    // 更新弹窗底部路径
    updateCategoryMovePath();

  

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
        w-[100px] min-w-[100px]
        max-h-[calc(100vh-16px)]
        overflow-y-auto
    `;

    menu.dataset.triggerPath = node.path;


menu.innerHTML = `
    <button data-act="add"
        class="w-full flex items-center text-left px-2.5 py-1 text-[13px] rounded hover:bg-slate-700 text-slate-200">
        <span class="w-5 shrink-0 inline-flex items-center justify-start">
            <svg xmlns="http://www.w3.org/2000/svg"
                 width="18" height="18"
                 viewBox="0 0 24 24"
                 fill="none"
                 stroke="currentColor"
                 stroke-width="1.7"
                 stroke-linecap="round"
                 stroke-linejoin="round">
                <path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5H10l2 2h7.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5H4.5A1.5 1.5 0 0 1 3 17.5z"/>
                <path d="M16.5 13v5"/>
                <path d="M14 15.5h5"/>
            </svg>
        </span>
        <span>子列表</span>
    </button>

    <button data-act="rename"
        class="w-full flex items-center text-left px-2.5 py-1 text-[13px] rounded hover:bg-slate-700 text-slate-200">
        <span class="w-5 shrink-0 inline-flex items-center justify-start">✏️</span>
        <span>重命名</span>
    </button>

    <button data-act="move"
    class="w-full flex items-center text-left px-2.5 py-1 text-[13px] rounded hover:bg-slate-700 text-slate-200">
    <span class="w-5 shrink-0 inline-flex items-center justify-start">
        <svg xmlns="http://www.w3.org/2000/svg"
             width="18" height="18"
             viewBox="0 0 24 24"
             fill="none"
             stroke="currentColor"
             stroke-width="1.7"
             stroke-linecap="round"
             stroke-linejoin="round">
            <path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5H10l2 2h7.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5H4.5A1.5 1.5 0 0 1 3 17.5z"/>
            <path d="M7 14h7"/>
            <path d="m11 11 3 3-3 3"/>
        </svg>
    </span>
    <span>移动</span>
</button>

    <button data-act="delete"
        class="w-full flex items-center text-left px-2.5 py-1 text-[13px] rounded hover:bg-red-600/20 text-red-400">
        <span class="w-5 shrink-0 inline-flex items-center justify-start">
            <span class="inline-flex origin-left translate-x-px">${window.TRASH_SVG}</span>
        </span>
        <span>删除</span>
    </button>
`;

    // 限制菜单尺寸，防止手机屏幕太窄或太矮时越界
    menu.style.maxWidth = "calc(100vw - 16px)";
    menu.style.maxHeight = "calc(100vh - 16px)";


    // 添加菜单，但暂时隐藏，避免首次显示时出现位置偏移
    menu.style.visibility = "hidden";
    document.body.appendChild(menu);
    moreMenuEl = menu;

    // ---------- 菜单位置跟随按钮 ----------
    const updateMoreMenuPosition = () => {
        if (!menu.isConnected || !btn.isConnected) return;

        const rect = btn.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();

        // 水平方向：菜单右边缘对齐“···”按钮左边缘
        let left = rect.left - menuRect.width;

        // 垂直方向：菜单顶部与“···”按钮顶部对齐
        let top = rect.top;

        // 防止菜单超出浏览器左右边界
        left = Math.max(
            8,
            Math.min(left, window.innerWidth - menuRect.width - 8)
        );

        // 防止菜单超出浏览器上下边界
        top = Math.max(
            8,
            Math.min(top, window.innerHeight - menuRect.height - 8)
        );

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    };

    // 强制浏览器完成菜单布局和尺寸计算
    menu.getBoundingClientRect();

    // 首次定位：等待浏览器完成布局后再计算
    requestAnimationFrame(() => {
        if (!menu.isConnected || !btn.isConnected) return;

        // 获取真实尺寸并计算菜单位置
        updateMoreMenuPosition();

        // 定位完成后再显示菜单
        menu.style.visibility = "visible";
    });

    // 使用 requestAnimationFrame 合并连续滚动事件
    let positionFrame = null;




  

    const scheduleMenuPositionUpdate = () => {
        if (positionFrame !== null) return;

        positionFrame = requestAnimationFrame(() => {
            positionFrame = null;
            updateMoreMenuPosition();
        });
    };

    // 监听页面及内部滚动容器的滚动
    document.addEventListener(
        "scroll",
        scheduleMenuPositionUpdate,
        true
    );

    // 监听浏览器窗口尺寸变化
    window.addEventListener(
        "resize",
        scheduleMenuPositionUpdate
    );

    // 保存监听函数和动画帧，供关闭菜单时清理
    menu._onMenuScroll = scheduleMenuPositionUpdate;
    menu._onMenuResize = scheduleMenuPositionUpdate;
    menu._positionFrame = () => positionFrame;

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

} else if (act === "move") {

    // 打开移动分类选择器
    chooseCategoryMoveTarget(node);

} else if (act === "delete") {

    openCategoryDelete(node);
}
    });
}


// ---------- 关闭更多菜单 ----------
function closeMoreMenu() {
    if (moreMenuEl) {

        // 移除滚动监听
        document.removeEventListener(
            "scroll",
            moreMenuEl._onMenuScroll,
            true
        );

        // 移除窗口尺寸监听
        window.removeEventListener(
            "resize",
            moreMenuEl._onMenuResize
        );

        // 取消尚未执行的位置更新
        const frame = moreMenuEl._positionFrame?.();

        if (frame !== null && frame !== undefined) {
            cancelAnimationFrame(frame);
        }

        // 移除菜单
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

        // 确保本地分类缓存已经初始化
        await loadCategoryTree();

        if (editContext.mode === "create") {

            // =========================
            // 新建分类
            // =========================

            const parentPath = editContext.parentPath;

            const createResult = await apiJson("/api/categories/create", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    parent_path: parentPath,
                    name
                })
            });

            if (!createResult?.success || !createResult?.path) {
                throw new Error("创建分类接口没有返回有效的创建结果");
            }

            // 只向本地缓存增加新分类
            addCategoryToCache({
                path: createResult.path,
                name,
                parent_path: createResult.parent_path,
                is_system: false
            });

            // 如果父分类原本处于折叠状态，展开它
            CategoryStore.expandedPaths.explorer.add(parentPath);

            // 如果父分类在保存区选择树中，保留原来的展开状态
            // 不强制修改其他树的展开状态

        } else {

            // =========================
            // 重命名分类
            // =========================

            const oldPath = editContext.node.path;

            const renameResult = await apiJson("/api/categories/rename", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    old_path: oldPath,
                    new_name: name
                })
            });

            const newPath = renameResult?.new_path;

            if (!renameResult?.success || !newPath) {
                throw new Error("重命名接口没有返回有效的新路径");
            }

            // 只更新本地缓存中对应分类及其后代
            updateCategoryPathInCache(
                oldPath,
                newPath,
                name
            );

            // 更新资源管理器当前路径
            if (
                CategoryStore.currentPath === oldPath ||
                CategoryStore.currentPath.startsWith(oldPath + "/")
            ) {
                CategoryStore.currentPath =
                    newPath + CategoryStore.currentPath.slice(oldPath.length);
            }

            // 更新保存区选中的分类
            if (
                CategoryStore.pickerPath === oldPath ||
                CategoryStore.pickerPath.startsWith(oldPath + "/")
            ) {
                CategoryStore.pickerPath =
                    newPath + CategoryStore.pickerPath.slice(oldPath.length);
            }

            // 更新移动书签选择器选中的分类
            if (
                CategoryStore.movePickerPath === oldPath ||
                CategoryStore.movePickerPath?.startsWith(oldPath + "/")
            ) {
                CategoryStore.movePickerPath =
                    newPath + CategoryStore.movePickerPath.slice(oldPath.length);
            }

            // 同步所有分类树的展开状态
            renameExpandedPaths(oldPath, newPath);

            // 通知 index.html 同步 AppState.category
            if (typeof window.onCategoryRenamed === "function") {

                window.onCategoryRenamed({
                    old_path: oldPath,
                    new_path: newPath
                });
            }
        }

        // 使用当前缓存重新渲染所有分类树
        renderAllCategoryTrees();

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

        // 确保本地分类缓存已经初始化
        await loadCategoryTree();

        const r = await apiJson("/api/categories/delete", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                path: deletedPath
            })
        });

        // 确认接口确实删除成功
        if (!r?.success || r.path !== deletedPath) {
            throw new Error("删除接口没有返回有效的删除结果");
        }

        // 清理失效路径和展开状态
        cleanupDeletedCategoryState(deletedPath);

        // 只从本地缓存删除对应分类及其后代
        removeCategoryFromCache(deletedPath);

        // 使用更新后的缓存重新渲染分类树
        renderAllCategoryTrees();

        closeCategoryDelete();

        // 通知 index.html 更新 AppState.category
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




// ============================================================
// 删除分类后，清理所有失效路径和展开状态
// ============================================================

function cleanupDeletedCategoryState(deletedPath) {

    const isInsideDeletedTree = (currentPath) => {

        if (!currentPath) return false;

        return currentPath === deletedPath ||
            currentPath.startsWith(deletedPath + "/");
    };

    // 资源管理器当前路径
    if (isInsideDeletedTree(CategoryStore.currentPath)) {

        CategoryStore.currentPath = "/default";
    }

    // 保存区选中路径
    if (isInsideDeletedTree(CategoryStore.pickerPath)) {

        CategoryStore.pickerPath = "/default";
    }

    // 移动书签选择器路径
    if (isInsideDeletedTree(CategoryStore.movePickerPath)) {

        CategoryStore.movePickerPath = null;
    }

  // 移动分类选择器路径
if (isInsideDeletedTree(CategoryStore.categoryMovePickerPath)) {

    CategoryStore.categoryMovePickerPath = null;
}

// 移动分类的源分类路径
if (isInsideDeletedTree(CategoryStore.categoryMoveSourcePath)) {

    CategoryStore.categoryMoveSourcePath = null;
}
  

    // 清理所有分类树的展开状态
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
// 移动分类专用选择器
// ============================================================

let categoryMoveResolve = null;


// ---------- 打开移动分类选择器 ----------
function openCategoryMovePicker(sourceNode) {

    const modal = document.createElement("div");

    modal.id = "categoryMovePickerModal";

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
                    移动分类
                </div>

                <button
                    type="button"
                    data-category-move-close
                    class="text-slate-400 hover:text-white text-xl"
                >×</button>
            </div>

            <div class="px-4 py-2 text-xs text-slate-400">
                选择要移动到的目标父分类。
                不能选择当前分类及其子分类。
            </div>

            <!-- 根目录选项 -->
            <button
                type="button"
                id="categoryMoveRootBtn"
                class="mx-3 mb-2 px-3 py-2 text-left text-sm
                       rounded-lg border border-slate-700
                       text-slate-300 hover:bg-slate-800"
            >
                📁 根目录
            </button>

            <!-- 分类树 -->
            <div
                id="categoryMovePickerTree"
                class="overflow-y-auto flex-1 min-h-0 px-3 py-2"
            ></div>

            <div class="
                px-4 py-3 border-t border-slate-700
                flex items-center justify-between gap-3
            ">

                <div
                    id="categoryMoveSelectedPath"
                    class="text-xs text-slate-400 truncate flex-1 min-w-0"
                >
                    尚未选择目标分类
                </div>

                <div class="flex items-center gap-2 shrink-0">

                    <button
                        type="button"
                        data-category-move-close
                        class="px-4 py-2 rounded-lg bg-slate-700
                               hover:bg-slate-600 text-white text-sm"
                    >取消</button>

                    <button
                        type="button"
                        id="categoryMovePickerConfirm"
                        class="px-4 py-2 rounded-lg bg-blue-600
                               hover:bg-blue-500 text-white text-sm"
                    >确定</button>

                </div>
            </div>

        </div>
    `;

    document.body.appendChild(modal);

    // 记录当前准备移动的分类
    CategoryStore.categoryMoveSourcePath = sourceNode.path;

    // 初始不选择目标父分类
    CategoryStore.categoryMovePickerPath = null;

    // 渲染分类树
    renderTreeInto(
        document.getElementById("categoryMovePickerTree"),
        "categoryMovePicker"
    );

    updateCategoryMovePath();

    // 根目录按钮
    modal.querySelector("#categoryMoveRootBtn")
        ?.addEventListener("click", () => {

            CategoryStore.categoryMovePickerPath = "/";

            updateCategoryMovePath();
        });

    // 取消按钮
    modal.querySelectorAll("[data-category-move-close]")
        .forEach(btn => {

            btn.addEventListener("click", () => {
                closeCategoryMovePicker(null);
            });

        });


    // 确认移动目标
    modal.querySelector("#categoryMovePickerConfirm")
        ?.addEventListener("click", () => {

            const targetPath = CategoryStore.categoryMovePickerPath;

            if (!targetPath) {
                alert("请先选择目标父分类");
                return;
            }

            const sourcePath = CategoryStore.categoryMoveSourcePath;

            // 再次检查，防止移动到自身或后代
            if (
                targetPath === sourcePath ||
                targetPath.startsWith(sourcePath + "/")
            ) {
                alert("不能将分类移动到自身或其子分类中");
                return;
            }

            closeCategoryMovePicker(targetPath);

        });

    // ESC 取消
    modal._escHandler = (e) => {

        if (e.key === "Escape") {
            closeCategoryMovePicker(null);
        }

    };

    document.addEventListener("keydown", modal._escHandler);
}


// ---------- 更新移动分类选择器路径 ----------
function updateCategoryMovePath() {

    const pathEl = document.getElementById(
        "categoryMoveSelectedPath"
    );

    if (!pathEl) return;

    const path = CategoryStore.categoryMovePickerPath;

    if (!path) {

        pathEl.textContent = "尚未选择目标分类";
        pathEl.title = "尚未选择目标分类";

        return;
    }

    pathEl.textContent = `移动到：${path === "/" ? "根目录" : path}`;
    pathEl.title = path;
}


// ---------- 关闭移动分类选择器 ----------
function closeCategoryMovePicker(result = null) {

    const modal = document.getElementById(
        "categoryMovePickerModal"
    );

    if (modal) {

        if (modal._escHandler) {
            document.removeEventListener(
                "keydown",
                modal._escHandler
            );
        }

        modal.remove();
    }

    const resolve = categoryMoveResolve;

    categoryMoveResolve = null;

    CategoryStore.categoryMoveSourcePath = null;
    CategoryStore.categoryMovePickerPath = null;

    if (resolve) {
        resolve(result);
    }
}


// ---------- 等待用户选择目标父分类 ----------
async function chooseCategoryMoveTarget(sourceNode) {

    try {

        // 确保分类缓存已经加载
        await loadCategoryTree();

        // 从最新缓存中重新获取源分类
        const sourcePath = sourceNode.path;

        const latestSourceNode = CategoryStore.treeCache.find(
            node => node.path === sourcePath
        );

        if (!latestSourceNode) {
            throw new Error("源分类不存在或已经被删除，请刷新分类树");
        }

        // 关闭可能存在的旧弹窗
        closeCategoryMovePicker(null);

        const targetPath = await new Promise((resolve) => {

            categoryMoveResolve = resolve;

            openCategoryMovePicker(latestSourceNode);

        });

        // 用户取消
        if (!targetPath) return;

        // 执行分类移动
        await submitCategoryMove(
            latestSourceNode.path,
            targetPath
        );

    } catch (e) {

        console.error("打开移动分类选择器失败：", e);

        alert(e.message || "无法打开移动分类选择器");
    }
}


// ============================================================
// 执行分类移动
// ============================================================

async function submitCategoryMove(sourcePath, targetParentPath) {

    try {

        // 再次检查目标是否合法
        if (
            targetParentPath === sourcePath ||
            targetParentPath.startsWith(sourcePath + "/")
        ) {
            throw new Error("不能将分类移动到自身或其子分类中");
        }

        // 请求后端移动分类接口
        const result = await apiJson("/api/categories/move", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                path: sourcePath,
                new_parent_path: targetParentPath
            })
        });

        if (!result?.success || !result?.new_path) {
            throw new Error(
                result?.error || "移动分类接口没有返回有效的新路径"
            );
        }

        const newPath = result.new_path;

        // 如果路径没有变化，则无需更新缓存
        if (newPath !== sourcePath) {

            // 更新分类自身及所有后代的缓存路径
            updateCategoryPathInCache(
                sourcePath,
                newPath
            );

            // 同步资源管理器当前路径
            if (
                CategoryStore.currentPath === sourcePath ||
                CategoryStore.currentPath.startsWith(sourcePath + "/")
            ) {
                CategoryStore.currentPath =
                    newPath + CategoryStore.currentPath.slice(sourcePath.length);
            }

            // 同步保存区选中路径
            if (
                CategoryStore.pickerPath === sourcePath ||
                CategoryStore.pickerPath.startsWith(sourcePath + "/")
            ) {
                CategoryStore.pickerPath =
                    newPath + CategoryStore.pickerPath.slice(sourcePath.length);
            }

            // 同步移动书签选择器选中路径
            if (
                CategoryStore.movePickerPath === sourcePath ||
                CategoryStore.movePickerPath?.startsWith(sourcePath + "/")
            ) {
                CategoryStore.movePickerPath =
                    newPath + CategoryStore.movePickerPath.slice(sourcePath.length);
            }

            // 同步所有分类树的展开状态
            renameExpandedPaths(sourcePath, newPath);
        }

        // 使用最新缓存重新渲染所有分类树
        renderAllCategoryTrees();

        // 通知 index.html 同步外部分类状态
        if (typeof window.onCategoryMoved === "function") {

            window.onCategoryMoved({
                old_path: sourcePath,
                new_path: newPath,
                new_parent_path: targetParentPath
            });
        }

        alert("分类移动成功");

    } catch (e) {

        console.error("移动分类失败：", e);

        alert(e.message || "移动分类失败");
    }
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

            <!-- 标题栏 -->
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

            <!-- 提示 -->
            <div class="px-4 py-2 text-xs text-slate-400">
                点击分类名称选择目标分类；点击左侧箭头可以展开或折叠子分类。
            </div>

            <!-- 分类树 -->
            <div
                id="moveCategoryPickerTree"
                class="overflow-y-auto flex-1 min-h-0 px-3 py-2"
            ></div>

            <!-- 底部操作栏 -->
            <div class="
                px-4 py-3 border-t border-slate-700
                flex items-center justify-between gap-3
            ">

                <!-- 左下角：当前选中的分类路径 -->
                <div
                    id="moveCategorySelectedPath"
                    class="text-xs text-slate-400 truncate flex-1 min-w-0"
                    title="/default"
                >
                    已选：/default
                </div>

                <!-- 右下角：取消 + 确定 -->
                <div class="flex items-center gap-2 shrink-0">

                    <button
                        type="button"
                        data-move-picker-close
                        class="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm"
                    >取消</button>

                    <button
                        type="button"
                        id="moveCategoryPickerConfirm"
                        class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm"
                    >确定</button>

                </div>
            </div>

        </div>
    `;

    document.body.appendChild(modal);

    // 初始不选中任何分类
    CategoryStore.movePickerPath = null;

    // 渲染分类树
    renderTreeInto(
        document.getElementById("moveCategoryPickerTree"),
        "movePicker"
    );

    // 初始化当前选中的分类路径
    updateMoveCategoryPath();

    // 取消按钮和右上角关闭按钮
    modal.querySelectorAll("[data-move-picker-close]").forEach(btn => {
        btn.addEventListener("click", () => {
            closeMoveCategoryPicker(null);
        });
    });


// 确定按钮：正式返回选中的分类路径
modal.querySelector("#moveCategoryPickerConfirm")
    ?.addEventListener("click", () => {

        // 尚未选择分类，不允许确认
        if (!CategoryStore.movePickerPath) {
            alert("请先选择目标分类");
            return;
        }

        closeMoveCategoryPicker(
            CategoryStore.movePickerPath
        );

    });

    // ESC 取消
    modal._escHandler = (e) => {
        if (e.key === "Escape") {
            closeMoveCategoryPicker(null);
        }
    };

    document.addEventListener("keydown", modal._escHandler);
}

// 更新移动分类弹窗左下角的当前选中路径
function updateMoveCategoryPath() {

    const pathEl = document.getElementById(
        "moveCategorySelectedPath"
    );

    if (!pathEl) return;

    const path = CategoryStore.movePickerPath;

    if (!path) {
        pathEl.textContent = "未选择";
        pathEl.title = "未选择";
        return;
    }

    pathEl.textContent = `已选：${path}`;
    pathEl.title = path;
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

// 输入框快捷键
document.getElementById("categoryEditInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitCategoryEdit();
    if (e.key === "Escape") closeCategoryEdit();
});

// 删除弹窗
document.getElementById("categoryDeleteConfirm")?.addEventListener("click", submitCategoryDelete);
document.getElementById("categoryDeleteCancel")?.addEventListener("click", closeCategoryDelete);
  }

// ---------- 对外 API ----------
window.CategoryExplorer = {

    CategoryStore,

    loadCategoryTree,
    invalidateTree,

    // 缓存管理
    rebuildCategoryIndex,
    addCategoryToCache,
    updateCategoryPathInCache,
    removeCategoryFromCache,

    // 统一渲染
    renderAllCategoryTrees,

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
    // 移动分类
openCategoryMovePicker,
closeCategoryMovePicker,
chooseCategoryMoveTarget,
  

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
    }
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
