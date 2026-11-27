//functions/api/[[route]].js
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });


// ============================================================
// 批量检查 D1 中已经存在的书签
// POST /api/bookmarks/check-duplicates
// body: { urls: [...] }
// ============================================================
if (
    path === '/api/bookmarks/check-duplicates' &&
    request.method === 'POST'
) {
    try {
        const body = await request.json();

const urls = Array.isArray(body.urls)
    ? [...new Set(
        body.urls
            .filter(item => typeof item === 'string')
            .map(item => item.trim())
            .filter(Boolean)
    )]
    : [];

        if (urls.length === 0) {
            return new Response(
                JSON.stringify({
                    success: true,
                    duplicates: []
                }),
                {
                    headers: {
                        ...corsHeaders,
                        'Content-Type': 'application/json'
                    }
                }
            );
        }

        // 防止一次提交过多数据
        if (urls.length > 60) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: '单次最多检查 60 个链接'
                }),
                {
                    status: 400,
                    headers: {
                        ...corsHeaders,
                        'Content-Type': 'application/json'
                    }
                }
            );
        }

        const duplicates = [];

        // 每 30 个 URL 执行一次 SQL，避免参数数量过多
        for (let i = 0; i < urls.length; i += 30) {

            const chunk = urls.slice(i, i + 30);

            const placeholders = chunk.map(() => '?').join(',');

            const result = await env.DB.prepare(`
                SELECT url
                FROM bookmarks
                WHERE url IN (${placeholders})
            `).bind(...chunk).all();

            const rows = result.results || [];

            for (const row of rows) {
                duplicates.push(row.url);
            }
        }

        return new Response(
            JSON.stringify({
                success: true,
                duplicates
            }),
            {
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json'
                }
            }
        );

    } catch (e) {

        console.error('批量检查重复链接失败：', e);

        return new Response(
            JSON.stringify({
                success: false,
                error: e.message || '批量检查失败'
            }),
            {
                status: 500,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json'
                }
            }
        );
    }
}





  

  // 1. 触发抓取  /api/save 并不是直接把书签保存到你的 D1 数据库，而是先让 Karakeep 抓取链接
  if (path === '/api/save' && request.method === 'POST') {
    try {
      const { url: targetUrl } = await request.json();
      const res = await fetch('https://karakeep.mcck.ccwu.cc/api/v1/bookmarks', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.KARAKEEP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl, type: "link" })
      });
      if (!res.ok) throw new Error("Karakeep 拒绝请求");
      const data = await res.json();
      return new Response(JSON.stringify({ success: true, bookmarkId: data.id }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  // 2. 查询状态，并给出【最稳妥的本地图链接】
  if (path === '/api/check-status' && request.method === 'GET') {
    try {
      const bookmarkId = url.searchParams.get('id');
      const res = await fetch(`https://karakeep.mcck.ccwu.cc/api/v1/bookmarks/${bookmarkId}`, {
        headers: { 'Authorization': `Bearer ${env.KARAKEEP_TOKEN}` }
      });
      const data = await res.json();

      if (!data.content || data.content.crawlStatus !== 'success') {
        return new Response(JSON.stringify({ status: 'processing' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      let title = data.content.title || "";
      let description = data.content.description || "";
      const originalUrl = data.content.url;
      const externalImageUrl = data.content.imageUrl || ""; 

      // 🎯 核心：取 Karakeep 本地的图片
      let localKarakeepImageUrl = "";
      if (data.content.imageAssetId) {
          localKarakeepImageUrl = `https://karakeep.mcck.ccwu.cc/api/assets/${data.content.imageAssetId}`;
      } else {
          localKarakeepImageUrl = externalImageUrl;
      }

      // 🌟 微信视频号专属处理
      if (originalUrl.includes("weixin.qq.com") || originalUrl.includes("channels.weixin.qq.com")) {
          // 1. 提取作者
          let authorName = data.content.author || "";
          if (authorName) {
              const match = authorName.match(/^(.*?)(?=\d{4,}|\d+\.\d+万|$)/);
              if (match && match[1]) authorName = match[1].trim();
          }
          title = authorName ? `视频号：${authorName}` : `微信视频号收藏 - ${new Date().toLocaleDateString('zh-CN')}`;

          // 2. 请求 Oracle 的 Playwright 接口去提文字
          description = "微信视频号内容暂不支持自动提取文本，请点击查看原文。"; // 默认兜底
          try {
              const extractRes = await fetch(`https://oracle.mcck.ccwu.cc/extract-wechat-text?bookmark_id=${bookmarkId}`);
              if (extractRes.ok) {
                  const extractData = await extractRes.json();
                  if (extractData.success && extractData.text) {
                      description = extractData.text;
                  }
              }
          } catch (e) {
              console.error("Oracle Playwright 提取失败", e);
          }
      }
      // 🌟 注意：YouTube 的 yt-dlp 拦截逻辑要放后面，或者用 else if
      else if (originalUrl.includes("youtube.com") || originalUrl.includes("youtu.be")) {
          try {
              const metaRes = await fetch(`https://oracle.mcck.ccwu.cc/yt-dlp-meta?url=${encodeURIComponent(originalUrl)}`);
              if (metaRes.ok) {
                  const meta = await metaRes.json();
                  if (meta.success && meta.description) {
                      description = meta.description; 
                  }
              }
          } catch (e) {
              console.error("yt-dlp 简介获取失败，回退使用 Karakeep 的原简介", e);
          }
      }

      return new Response(JSON.stringify({ 
          status: 'success', 
          data: { 
              url: originalUrl, 
              title, 
              description, // 这里返回的 description 已经是覆盖后的真实简介了
              imageUrl: externalImageUrl,       
              karakeepLocalImage: localKarakeepImageUrl,
              karakeepId: bookmarkId
          } 
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

// 3. 存入 D1（支持 category_path） /api/store：将抓取完成的书签信息正式写入你的 D1 数据库。
if (path === '/api/store' && request.method === 'POST') {
  try {
    const { url: originalUrl, title, description, imageUrl, imgFileId, category_path, karakeepId } = await request.json();
    const finalCategory = (category_path || '/default').trim() || '/default';

    // 校验分类存在
    const cat = await env.DB.prepare(`SELECT path FROM categories WHERE path = ?`).bind(finalCategory).first();
    if (!cat) {
      return new Response(JSON.stringify({ error: '分类不存在' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }


// 插入书签，并在新增成功时返回完整记录
const record = await env.DB.prepare(`
    INSERT INTO bookmarks
    (
        url,
        title,
        description,
        image_url,
        img_file_id,
        category_path,
        karakeep_id,
        updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(url) DO NOTHING
    RETURNING *
`).bind(
    originalUrl,
    title,
    description,
    imageUrl,
    imgFileId,
    finalCategory,
    karakeepId
).first();

const inserted = !!record;

return new Response(
    JSON.stringify({
        success: true,
        duplicate: !inserted,
        record: record || null
    }),
    {
        headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
        }
    }
);

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
}


// ========== 分类：树 ==========
if (path === '/api/categories/tree' && request.method === 'GET') {
  try {
    const { results } = await env.DB.prepare(
      `SELECT path, name, parent_path, is_system FROM categories ORDER BY path`
    ).all();
    const rows = results || [];

    // 动态算 has_children / child_count
    const childCount = {};
    for (const r of rows) {
      childCount[r.parent_path] = (childCount[r.parent_path] || 0) + 1;
    }
    const data = rows.map(r => ({
      path: r.path,
      name: r.name,
      parent_path: r.parent_path,
      is_system: r.is_system,
      has_children: (childCount[r.path] || 0) > 0,
      child_count: childCount[r.path] || 0,
    }));

    return new Response(JSON.stringify({ success: true, data }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// ========== 分类：新建 ==========
if (path === '/api/categories/create' && request.method === 'POST') {
  try {
const data = await request.json();
const { parent_path, name } = data || {};

// 1. 检查参数类型
// 允许省略 parent_path，默认创建在根目录
if (
    (parent_path !== undefined &&
     parent_path !== null &&
     typeof parent_path !== 'string') ||
    typeof name !== 'string'
) {
    return new Response(JSON.stringify({
        success: false,
        error: '参数格式不正确'
    }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

const parentPath = (
    parent_path == null ? '/' : parent_path
).trim();

const rawName = name.trim();

// 2. 检查父分类路径格式
if (
    parentPath !== '/' &&
    (
        !parentPath.startsWith('/') ||
        parentPath.endsWith('/') ||
        parentPath.includes('//') ||
        parentPath.split('/').slice(1).some(segment =>
            !segment ||
            segment === '.' ||
            segment === '..'
        )
    )
) {
    return new Response(JSON.stringify({
        success: false,
        error: '父分类路径格式不正确'
    }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// 3. 检查分类名称
if (!rawName) {
    return new Response(JSON.stringify({
        success: false,
        error: '分类名称不能为空'
    }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// 4. 限制名称长度
if (Array.from(rawName).length > 100) {
    return new Response(JSON.stringify({
        success: false,
        error: '分类名称不能超过 100 个字符'
    }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// 5. 分类名称不能包含路径分隔符
if (rawName.includes('/')) {
    return new Response(JSON.stringify({
        success: false,
        error: '分类名称不能包含 /'
    }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

    const normalizedParent = parentPath;

    // 校验父分类存在
    if (normalizedParent !== '/') {
      const parent = await env.DB.prepare(
        `SELECT path FROM categories WHERE path = ?`
      ).bind(normalizedParent).first();
      if (!parent) {
        return new Response(JSON.stringify({ error: '父分类不存在' }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    const newPath = normalizedParent === '/'
      ? `/${rawName}`
      : `${normalizedParent}/${rawName}`;

    // 校验重名
    const exists = await env.DB.prepare(
      `SELECT path FROM categories WHERE path = ?`
    ).bind(newPath).first();
    if (exists) {
      return new Response(JSON.stringify({ error: '同名分类已存在' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    await env.DB.prepare(
      `INSERT INTO categories (path, name, parent_path, is_system) VALUES (?, ?, ?, 0)`
    ).bind(newPath, rawName, normalizedParent).run();

    return new Response(JSON.stringify({ success: true, path: newPath, name: rawName, parent_path: normalizedParent }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('分类创建失败:', e);

    const errorMessage = String(
        e?.message || e || ''
    );

    // 判断分类路径主键或唯一约束冲突
    const isPathConflict =
        /categories\.path/i.test(errorMessage) &&
        /(unique|primary key|constraint)/i.test(errorMessage);

    if (isPathConflict) {
        return new Response(JSON.stringify({
            success: false,
            error: '同名分类已存在'
        }), {
            status: 409,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    return new Response(JSON.stringify({
        success: false,
        error: '分类创建失败'
    }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

  }


  
// ========== 分类：重命名 ==========
if (path === '/api/categories/rename' && request.method === 'POST') {
  try {
    const data = await request.json();

    const { old_path, new_name } = data || {};

    // 1. 检查参数类型
    if (
      typeof old_path !== 'string' ||
      typeof new_name !== 'string'
    ) {
      return new Response(JSON.stringify({
        success: false,
        error: '参数格式不正确'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const oldPath = old_path.trim();
    const rawName = new_name.trim();

    // 2. 检查原分类路径
    if (!oldPath || oldPath === '/') {
      return new Response(JSON.stringify({
        success: false,
        error: '无效的分类路径'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 必须以 / 开头，不能以 / 结尾，不能包含连续的 //
    if (
      !oldPath.startsWith('/') ||
      oldPath.endsWith('/') ||
      oldPath.includes('//') ||
      oldPath.split('/').slice(1).some(segment =>
        !segment ||
        segment === '.' ||
        segment === '..'
      )
    ) {
      return new Response(JSON.stringify({
        success: false,
        error: '分类路径格式不正确'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 3. 检查新分类名称
    if (!rawName) {
      return new Response(JSON.stringify({
        success: false,
        error: '新名称不能为空'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 限制名称最多 100 个 Unicode 字符
    if (Array.from(rawName).length > 100) {
      return new Response(JSON.stringify({
        success: false,
        error: '分类名称不能超过 100 个字符'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 分类名称不能包含路径分隔符
    if (rawName.includes('/')) {
      return new Response(JSON.stringify({
        success: false,
        error: '分类名称不能包含 /'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 系统分类禁止重命名
    const target = await env.DB.prepare(
      `SELECT path, name, parent_path, is_system FROM categories WHERE path = ?`
    ).bind(oldPath).first();
    if (!target) {
      return new Response(JSON.stringify({ error: '分类不存在' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (Number(target.is_system) === 1) {
      return new Response(JSON.stringify({ error: '系统分类不可重命名' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const parentPath = target.parent_path;
    const newPath = parentPath === '/'
      ? `/${rawName}`
      : `${parentPath}/${rawName}`;

    if (newPath === oldPath) {
      return new Response(JSON.stringify({ success: true, new_path: oldPath, message: '名称未变化' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

// 检查新路径及其子路径是否已经被占用
const newPrefix = newPath + '/';

const exists = await env.DB.prepare(`
    SELECT path
    FROM categories
    WHERE path = ?
       OR substr(path, 1, length(?)) = ?
    LIMIT 1
`).bind(
    newPath,
    newPrefix,
    newPrefix
).first();

if (exists) {
    return new Response(JSON.stringify({
        success: false,
        error: '目标位置已经存在分类路径：' + exists.path
    }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// ============================================================
// 精简重命名：3 条 SQL 更新整棵分类子树
// ============================================================

const oldPrefix = oldPath + '/';

// 1. 更新当前分类及所有后代分类的 path，同时更新当前分类名称
const stmts = [

env.DB.prepare(`
    UPDATE categories
    SET
        path = CASE
            WHEN path = ? THEN ?
            ELSE ? || substr(path, length(?) + 1)
        END,
        name = CASE
            WHEN path = ? THEN ?
            ELSE name
        END
    WHERE path = ? OR substr(path, 1, length(?)) = ?
`).bind(
    oldPath,
    newPath,
    newPath,
    oldPath,
    oldPath,
    rawName,
    oldPath,
    oldPrefix,
    oldPrefix
),

    // 2. 更新所有后代分类的 parent_path
env.DB.prepare(`
    UPDATE categories
    SET parent_path = CASE
        WHEN parent_path = ? THEN ?
        ELSE ? || substr(parent_path, length(?) + 1)
    END
    WHERE parent_path = ? OR substr(parent_path, 1, length(?)) = ?
`).bind(
    oldPath,
    newPath,
    newPath,
    oldPath,
    oldPath,
    oldPrefix,
    oldPrefix
),

    // 3. 更新当前分类及所有后代分类中的书签路径
env.DB.prepare(`
    UPDATE bookmarks
    SET category_path = CASE
        WHEN category_path = ? THEN ?
        ELSE ? || substr(category_path, length(?) + 1)
    END
    WHERE category_path = ? OR substr(category_path, 1, length(?)) = ?
`).bind(
    oldPath,
    newPath,
    newPath,
    oldPath,
    oldPath,
    oldPrefix,
    oldPrefix
)

];

// 一次性批量执行
await env.DB.batch(stmts);
    return new Response(JSON.stringify({ success: true, old_path: oldPath, new_path: newPath, name: rawName }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (e) {
    console.error('分类重命名失败:', e);

    const errorMessage = String(
      e?.message || e || ''
    );

    // 判断是否为分类路径主键或唯一约束冲突
    const isPathConflict =
      /categories\.path/i.test(errorMessage) &&
      /(unique|primary key|constraint)/i.test(errorMessage);

    if (isPathConflict) {
      return new Response(JSON.stringify({
        success: false,
        error: '目标分类路径已存在，请更换分类名称'
      }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: false,
      error: '分类重命名失败'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}




// ========== 分类：移动（连带移动所有子分类和书签）==========
// POST /api/categories/move
// body: { path: "/旧分类", new_parent_path: "/目标父分类" }
// new_parent_path 为 "/" 时表示移动到根目录

if (path === '/api/categories/move' && request.method === 'POST') {

  try {

    const body = await request.json();

    const sourcePath = typeof body.path === 'string'
      ? body.path.trim()
      : '';

    const targetParentPath = typeof body.new_parent_path === 'string'
      ? body.new_parent_path.trim()
      : '';

    // 统一响应格式
    const jsonResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    };

    // 1. 检查路径参数
    if (
      !sourcePath ||
      sourcePath === '/' ||
      !sourcePath.startsWith('/') ||
      sourcePath.endsWith('/') ||
      sourcePath.includes('//') ||
      !targetParentPath ||
      !targetParentPath.startsWith('/') ||
      (targetParentPath !== '/' &&
        (targetParentPath.endsWith('/') ||
         targetParentPath.includes('//')))
    ) {
      return jsonResponse({
        success: false,
        error: '无效的分类路径'
      }, 400);
    }

    // 2. 查询全部分类，后续用于检查和生成子树路径映射
    const categoryResult = await env.DB.prepare(`
      SELECT path, name, parent_path, is_system
      FROM categories
    `).all();

    const categories = categoryResult.results || [];

    const categoryMap = new Map(
      categories.map(item => [item.path, item])
    );

    // 3. 检查源分类是否存在
    const source = categoryMap.get(sourcePath);

    if (!source) {
      return jsonResponse({
        success: false,
        error: '源分类不存在'
      }, 404);
    }

    // 4. 禁止移动系统分类
    if (Number(source.is_system) === 1) {
      return jsonResponse({
        success: false,
        error: '系统分类不可移动'
      }, 403);
    }

    // 5. 检查目标父分类是否存在
    // "/" 表示根目录，不需要在 categories 表中查找
    if (
      targetParentPath !== '/' &&
      !categoryMap.has(targetParentPath)
    ) {
      return jsonResponse({
        success: false,
        error: '目标父分类不存在'
      }, 404);
    }

    // 6. 禁止移动到自身或自己的后代
    if (
      targetParentPath === sourcePath ||
      targetParentPath.startsWith(sourcePath + '/')
    ) {
      return jsonResponse({
        success: false,
        error: '不能将分类移动到自身或其子分类中'
      }, 400);
    }

    // 7. 如果目标父分类就是原来的父分类，无需移动
    const oldParentPath = source.parent_path || '/';

    if (targetParentPath === oldParentPath) {
      return jsonResponse({
        success: true,
        old_path: sourcePath,
        new_path: sourcePath,
        new_parent_path: targetParentPath,
        message: '分类已经位于目标位置'
      });
    }

    // 8. 计算移动后的源分类路径
    const newPath = targetParentPath === '/'
      ? `/${source.name}`
      : `${targetParentPath}/${source.name}`;

    // 9. 找出源分类及其所有后代
    // 使用 startsWith 判断，避免 SQL LIKE 中 % 和 _ 的特殊含义
    const subtree = categories.filter(item => {
      return item.path === sourcePath ||
        item.path.startsWith(sourcePath + '/');
    });

    // 10. 建立旧路径集合
    const oldPathSet = new Set(
      subtree.map(item => item.path)
    );

    // 11. 为整个子树生成新路径映射
    const pathMap = new Map();

    for (const item of subtree) {

      const updatedPath = item.path === sourcePath
        ? newPath
        : newPath + item.path.slice(sourcePath.length);

      pathMap.set(item.path, updatedPath);
    }

    // 12. 检查所有新路径是否与现有分类冲突
    // 不仅检查源分类，还要检查所有后代分类
    const newPathSet = new Set();

    for (const updatedPath of pathMap.values()) {

      // 防止新路径之间发生冲突
      if (newPathSet.has(updatedPath)) {
        return jsonResponse({
          success: false,
          error: '移动后存在重复的分类路径'
        }, 409);
      }

      newPathSet.add(updatedPath);

      // 检查目标路径是否被子树以外的分类占用
      if (
        categoryMap.has(updatedPath) &&
        !oldPathSet.has(updatedPath)
      ) {
        return jsonResponse({
          success: false,
          error: `目标位置已经存在同名分类：${updatedPath}`
        }, 409);
      }
    }


// ============================================================
// 13. 为整个分类子树生成唯一的临时根路径
// ============================================================

// 收集现有分类路径
const existingPaths = new Set(
    categories.map(item => item.path)
);

// 使用一个统一的临时根路径
let temporaryRootPath;

// 防止临时根路径与现有分类路径冲突
do {

    temporaryRootPath =
        `/__category_move_tmp_${crypto.randomUUID()}`;

} while (
    existingPaths.has(temporaryRootPath) ||
    categories.some(item =>
        item.path.startsWith(temporaryRootPath + '/')
    )
);


// ============================================================
// 14. 构建固定数量的 D1 更新语句
// ============================================================

const statements = [];


// ------------------------------------------------------------
// 第一阶段：将整个分类子树移动到统一临时根路径
// ------------------------------------------------------------

const oldPrefix = sourcePath + '/';

statements.push(

    env.DB.prepare(`
        UPDATE categories
        SET path =
            ? || substr(path, length(?) + 1)
        WHERE
            path = ?
            OR substr(path, 1, length(?)) = ?
    `).bind(
        temporaryRootPath,
        sourcePath,
        sourcePath,
        oldPrefix,
        oldPrefix
    )

);


// ------------------------------------------------------------
// 第二阶段：将整个分类子树更新为最终路径
// 同时更新所有后代分类的 parent_path
// ------------------------------------------------------------

statements.push(

    env.DB.prepare(`
        UPDATE categories
        SET
            path =
                ? || substr(path, length(?) + 1),

            parent_path =
                CASE
                    WHEN path = ?
                    THEN ?

                    ELSE
                        ? || substr(
                            parent_path,
                            length(?) + 1
                        )
                END

        WHERE
            path = ?
            OR substr(path, 1, length(?)) = ?
    `).bind(
        newPath,
        temporaryRootPath,

        temporaryRootPath,
        targetParentPath,

        newPath,
        sourcePath,

        temporaryRootPath,
        temporaryRootPath + '/',
        temporaryRootPath + '/'
    )

);


// ------------------------------------------------------------
// 第三阶段：一次性更新整个分类子树中的所有书签
// ------------------------------------------------------------

statements.push(

    env.DB.prepare(`
        UPDATE bookmarks
        SET category_path =
            ? || substr(
                category_path,
                length(?) + 1
            )
        WHERE
            category_path = ?
            OR substr(
                category_path,
                1,
                length(?)
            ) = ?
    `).bind(
        newPath,
        sourcePath,
        sourcePath,
        oldPrefix,
        oldPrefix
    )

);

// ============================================================
// 15. 使用 D1 batch 原子执行全部更新
// ============================================================

// 现在只有 3 条 UPDATE SQL
// 任意一条 SQL 失败，整个批次都会回滚

await env.DB.batch(statements);

    // 16. 返回移动结果
    return jsonResponse({
      success: true,
      old_path: sourcePath,
      new_path: newPath,
      new_parent_path: targetParentPath,
      moved_categories: subtree.length,
      message: '分类移动成功'
    });

  } catch (e) {

    console.error('移动分类失败：', e);

    // 如果发生唯一约束冲突，返回明确的业务错误
    if (
      e.message &&
      (
        e.message.toLowerCase().includes('unique') ||
        e.message.toLowerCase().includes('constraint')
      )
    ) {
      return new Response(JSON.stringify({
        success: false,
        error: '移动失败，目标位置存在分类路径冲突'
      }), {
        status: 409,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }

    return new Response(JSON.stringify({
      success: false,
      error: e.message || '移动分类失败'
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
}


  

// ========== 分类：删除（连带子分类 + 链接）==========
if (path === '/api/categories/delete' && request.method === 'POST') {
    try {
        const { path: targetPath } = await request.json();
        const delPath = (targetPath || '').trim();

        if (!delPath || delPath === '/') {
            return new Response(JSON.stringify({
                success: false,
                error: '无效的分类路径'
            }), {
                status: 400,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json'
                }
            });
        }

        // 查询目标分类
        const target = await env.DB.prepare(`
            SELECT path, is_system
            FROM categories
            WHERE path = ?
        `).bind(delPath).first();

        if (!target) {
            return new Response(JSON.stringify({
                success: false,
                error: '分类不存在'
            }), {
                status: 404,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json'
                }
            });
        }

        // 系统分类禁止删除
        if (Number(target.is_system) === 1) {
            return new Response(JSON.stringify({
                success: false,
                error: '系统分类不可删除'
            }), {
                status: 403,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json'
                }
            });
        }

const prefix = delPath + '/';

const results = await env.DB.batch([

    // 1. 统计即将删除的书签所属范围
    env.DB.prepare(`
        SELECT

            SUM(
                CASE
                    WHEN status != 'archived' THEN 1
                    ELSE 0
                END
            ) AS home_count,

            SUM(
                CASE
                    WHEN status = 'archived' THEN 1
                    ELSE 0
                END
            ) AS archive_count,

            SUM(
                CASE
                    WHEN is_favorite = 1 THEN 1
                    ELSE 0
                END
            ) AS favorite_count

        FROM bookmarks

        WHERE category_path = ?
           OR substr(category_path, 1, length(?)) = ?
    `).bind(delPath, prefix, prefix),

    // 2. 删除当前分类及其所有后代分类中的书签
    env.DB.prepare(`
        DELETE FROM bookmarks
        WHERE category_path = ?
           OR substr(category_path, 1, length(?)) = ?
    `).bind(delPath, prefix, prefix),

    // 3. 删除当前分类及其所有后代分类
    env.DB.prepare(`
        DELETE FROM categories
        WHERE path = ?
           OR substr(path, 1, length(?)) = ?
    `).bind(delPath, prefix, prefix)

]);

// ---------- 读取统计结果 ----------

// 第一条 SQL 是 SELECT，读取 results
const stats = results[0]?.results?.[0] || {};

const deletedBookmarks = Number(results[1]?.meta?.changes || 0);
const deletedCategories = Number(results[2]?.meta?.changes || 0);

// ---------- 整理三个范围的删除数量 ----------

const deletedHome = Number(stats.home_count || 0);
const deletedArchive = Number(stats.archive_count || 0);
const deletedFavorites = Number(stats.favorite_count || 0);



        return new Response(JSON.stringify({
            success: true,
            path: delPath,
            deleted_categories: deletedCategories,
            deleted_bookmarks: deletedBookmarks,

    // 三个范围实际删除的书签数量
    deleted_home: deletedHome,
    deleted_archive: deletedArchive,
    deleted_favorites: deletedFavorites
        
        }), {
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json'
            }
        });

    } catch (e) {
        console.error('删除分类失败：', e);

        return new Response(JSON.stringify({
            success: false,
            error: e.message || '删除分类失败'
        }), {
            status: 500,
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json'
            }
        });
    }
}

  

// 4. 读取列表（支持 scope / category / keyword / 分页）
if (path === '/api/list' && request.method === 'GET') {
  try {
    const scope = url.searchParams.get('scope') || 'home';       // home | fav | archive | category
    const category = url.searchParams.get('category') || '';
    const keyword = (url.searchParams.get('keyword') || '').trim();
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') || '20', 10) || 20));
    // 第一页溢出数量
    // 只有请求第二页及以后时，才使用这个参数
    const requestedOverflow = parseInt(url.searchParams.get('overflowCount') || '0',10);
    const overflowCount = page > 1 && Number.isSafeInteger(requestedOverflow)
        ? Math.max(0, requestedOverflow)
        : 0;
    // 计算实际 OFFSET
    const offset = (page - 1) * pageSize + overflowCount;

    // ---------- 查询条件 ----------
    const where = [];
    const binds = [];

    if (scope === 'home') {
      where.push(`status != 'archived'`);

    } else if (scope === 'fav') {
      where.push(`is_favorite = 1`);

    } else if (scope === 'archive') {
      where.push(`status = 'archived'`);

    } else if (scope === 'category') {

      if (!category) {
        return new Response(JSON.stringify({
          success: true,
          data: [],
          total: 0,
          totalPages: 0,
          page,
          pageSize,
          overflowCount: 0
        }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }

      where.push(`category_path = ?`);
      binds.push(category);

    } else {
      return new Response(JSON.stringify({
        error: '无效的 scope'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }

    // 关键词搜索
    if (keyword) {
      where.push(
        `(title LIKE ? OR description LIKE ? OR url LIKE ?)`
      );

      const like = `%${keyword}%`;
      binds.push(like, like, like);
    }

    const whereSql = where.length
      ? `WHERE ${where.join(' AND ')}`
      : '';


    // ---------- 查询总数 ----------
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS c
       FROM bookmarks
       ${whereSql}`
    ).bind(...binds).first();

    const total = Number(countRow?.c || 0);


    // ---------- 计算总页数 ----------
    // 第一页实际容量 = pageSize + overflowCount
    const firstPageCount = Math.min(
      total,
      pageSize + overflowCount
    );

    const totalPages = total === 0
      ? 0
      : 1 + Math.ceil(
          Math.max(0, total - firstPageCount) / pageSize
        );


    // ---------- 查询当前页 ----------
    const { results } = await env.DB.prepare(
      `SELECT *
       FROM bookmarks
       ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`
    ).bind(
      ...binds,
      pageSize,
      offset
    ).all();


    return new Response(JSON.stringify({
      success: true,
      data: results || [],
      total,
      totalPages,
      page,
      pageSize,
      overflowCount,
      scope,
      category: scope === 'category' ? category : null,
      keyword
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });

  } catch (e) {
    return new Response(JSON.stringify({
      error: e.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}
// ========== 卡片：批量操作 ==========
if (path === '/api/bookmark/batch' && request.method === 'POST') {
  try {
    const { ids, action, payload } = await request.json();
    if (!Array.isArray(ids) || ids.length === 0) {
      return new Response(JSON.stringify({ error: 'ids 不能为空' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 去重 + 只保留数字
    const cleanIds = [...new Set(ids.map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0))];
    if (cleanIds.length === 0) {
      return new Response(JSON.stringify({ error: '无效的 ids' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const placeholders = cleanIds.map(() => '?').join(',');

    if (action === 'delete') {
      const r = await env.DB.prepare(
        `DELETE FROM bookmarks WHERE id IN (${placeholders})`
      ).bind(...cleanIds).run();
      return new Response(JSON.stringify({ success: true, affected: r.meta?.changes || 0, action }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (action === 'favorite') {
      const fav = payload?.is_favorite ? 1 : 0;
      const r = await env.DB.prepare(
        `UPDATE bookmarks SET is_favorite = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`
      ).bind(fav, ...cleanIds).run();
      return new Response(JSON.stringify({ success: true, affected: r.meta?.changes || 0, action, is_favorite: fav }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (action === 'archive') {
      const archived = payload?.archived ? 1 : 0;
      const newStatus = archived ? 'archived' : 'active';
      const r = await env.DB.prepare(
        `UPDATE bookmarks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`
      ).bind(newStatus, ...cleanIds).run();
      return new Response(JSON.stringify({ success: true, affected: r.meta?.changes || 0, action, status: newStatus }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (action === 'move') {
      const target = (payload?.target_category || '').trim();
      if (!target) {
        return new Response(JSON.stringify({ error: '目标分类不能为空' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      const cat = await env.DB.prepare(`SELECT path FROM categories WHERE path = ?`).bind(target).first();
      if (!cat) {
        return new Response(JSON.stringify({ error: '目标分类不存在' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
const r = await env.DB.prepare(
    `UPDATE bookmarks SET category_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`
).bind(target, ...cleanIds).run();

// 实际成功移动的数量
const successCount = Number(r.meta?.changes || 0);

// 未成功移动的数量
const failedCount = Math.max(0, cleanIds.length - successCount);

return new Response(JSON.stringify({
    success: true,
    action,
    target_category: target,
    affected: successCount,
    success_count: successCount,
    failed_count: failedCount,
    total: cleanIds.length
}), {
    headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
    }
});
    }

    return new Response(JSON.stringify({ error: '未知的 action' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}  


// ========== 卡片：编辑 ==========
if (path === '/api/bookmark/update' && request.method === 'POST') {
  try {
    const data = await request.json();

    const {
      id,
      title,
      description,
      url: newUrl,
      tags,
      notes,
      summary
    } = data;

    // 1. 校验 ID
    const bookmarkId = Number(id);

    if (!Number.isInteger(bookmarkId) || bookmarkId <= 0) {
      return new Response(JSON.stringify({
        success: false,
        error: '无效的 id'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. 查询原书签
    const existing = await env.DB.prepare(
      `SELECT * FROM bookmarks WHERE id = ?`
    ).bind(bookmarkId).first();

    if (!existing) {
      return new Response(JSON.stringify({
        success: false,
        error: '卡片不存在'
      }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 3. 处理六个字段
    // 未提交的字段保留原值，避免其他调用方式意外清空数据
    const finalTitle = title !== undefined
      ? String(title).trim()
      : (existing.title || '');

    const finalDesc = description !== undefined
      ? String(description)
      : (existing.description || '');

    const finalUrl = newUrl !== undefined
      ? String(newUrl).trim()
      : (existing.url || '');

    const finalNotes = notes !== undefined
      ? String(notes)
      : (existing.notes || '');

    const finalSummary = summary !== undefined
      ? String(summary)
      : (existing.summary || '');

    if (!finalUrl) {
      return new Response(JSON.stringify({
        success: false,
        error: 'URL 不能为空'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 4. 处理标签，数据库统一保存 JSON 数组
    let finalTags;

    if (tags !== undefined) {
      if (Array.isArray(tags)) {
        finalTags = [...new Set(
          tags
            .map(tag => String(tag).trim())
            .filter(Boolean)
        )];
      } else {
        return new Response(JSON.stringify({
          success: false,
          error: 'tags 必须是数组'
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    } else {
      // 没有提交标签时，保留数据库原来的标签
      try {
        const oldTags = JSON.parse(existing.tags || '[]');
        finalTags = Array.isArray(oldTags) ? oldTags : [];
      } catch {
        finalTags = [];
      }
    }

    const tagsJson = JSON.stringify(finalTags);

    // 5. 如果修改了 URL，检查是否与其他书签重复
    if (finalUrl !== existing.url) {
      const dup = await env.DB.prepare(
        `SELECT id FROM bookmarks WHERE url = ? AND id != ?`
      ).bind(finalUrl, bookmarkId).first();

      if (dup) {
        return new Response(JSON.stringify({
          success: false,
          error: '该 URL 已存在'
        }), {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // 6. 一次性更新六个字段
    // 不修改封面图、分类、收藏状态和归档状态
    await env.DB.prepare(`
      UPDATE bookmarks
      SET
        url = ?,
        title = ?,
        description = ?,
        tags = ?,
        notes = ?,
        summary = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      finalUrl,
      finalTitle,
      finalDesc,
      tagsJson,
      finalNotes,
      finalSummary,
      bookmarkId
    ).run();

    // 7. 查询更新后的完整书签
    const updated = await env.DB.prepare(
      `SELECT * FROM bookmarks WHERE id = ?`
    ).bind(bookmarkId).first();

    return new Response(JSON.stringify({
      success: true,
      data: updated
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (e) {
    console.error('更新书签失败:', e);

    // URL 唯一性冲突
    if (
      e.message &&
      e.message.toLowerCase().includes('unique')
    ) {
      return new Response(JSON.stringify({
        success: false,
        error: '该 URL 已存在，不能重复保存'
      }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: false,
      error: e.message || '更新书签失败'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
 

  return new Response('Not Found', { status: 404, headers: corsHeaders });
}
