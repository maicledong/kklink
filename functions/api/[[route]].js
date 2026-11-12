export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // 1. 触发 Karakeep 抓取
  if (path === '/api/save' && request.method === 'POST') {
    try {
      const { url: targetUrl } = await request.json();
      const res = await fetch('https://karakeep.mcck.ccwu.cc/api/v1/bookmarks', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.KARAKEEP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: targetUrl, type: "link" })
      });
      
      const data = await res.json();
      
      // 打印真实的创建结果
      console.log("【Karakeep 创建返回】:", JSON.stringify(data));

      return new Response(JSON.stringify({ success: true, bookmarkId: data.id }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  // 2. 轮询状态并写入 D1
  if (path === '/api/check-status' && request.method === 'GET') {
    try {
      const bookmarkId = url.searchParams.get('id');
      const res = await fetch(`https://karakeep.mcck.ccwu.cc/api/v1/bookmarks/${bookmarkId}`, {
        headers: { 'Authorization': `Bearer ${env.KARAKEEP_TOKEN}` }
      });
      const data = await res.json();

      // 🔥 关键：打印真实的单条查询结果，看看到底有没有成功！
      console.log("【Karakeep 状态查询】:", JSON.stringify(data));

      // Karakeep 的抓取状态可能是 'success', 'completed' 等，我们把判断放宽一点
      // 只要它有 title 且不是空，或者 crawlStatus 不是 pending，我们就认为抓好了
      const isSuccess = data.crawlStatus === 'success' || data.crawlStatus === 'completed' || (data.title && data.title !== "无标题");

      if (!isSuccess) {
        return new Response(JSON.stringify({ status: 'processing', raw: data.crawlStatus }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const title = data.title || "无标题";
      const description = data.description || "";
      
      let imageUrl = "";
      
      // 解析图片链接
      // 1. 如果 Karakeep 直接给了 imageUrl (外部链接)
      if (data.imageUrl) {
        imageUrl = data.imageUrl;
      } 
      // 2. 如果 Karakeep 返回了 assetId (由于你开启了本地存图)
      else if (data.content && data.content.imageAssetId) {
        imageUrl = `https://karakeep.mcck.ccwu.cc/api/assets/${data.content.imageAssetId}`;
      }
      // 3. 有的版本存在 content.imageUrl
      else if (data.content && data.content.imageUrl) {
        imageUrl = data.content.imageUrl;
      }

      // 写入 D1 数据库
      await env.DB.prepare(
        `INSERT OR IGNORE INTO bookmarks (url, title, description, image_url) VALUES (?, ?, ?, ?)`
      ).bind(data.url, title, description, imageUrl).run();

      return new Response(JSON.stringify({ status: 'success' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  // 3. 获取 D1 列表
  if (path === '/api/list' && request.method === 'GET') {
    try {
      const { results } = await env.DB.prepare(`SELECT * FROM bookmarks ORDER BY created_at DESC`).all();
      return new Response(JSON.stringify({ success: true, data: results }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders });
}
