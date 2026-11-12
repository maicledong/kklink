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
      
      if (!res.ok) throw new Error("Karakeep 触发失败");
      const data = await res.json();
      
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

      // 检查抓取状态（Karakeep 抓取成功时状态为 "success"）
      if (data.crawlStatus !== 'success') {
        return new Response(JSON.stringify({ status: 'processing' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // 修正：根据 Karakeep 实际 API 结构提取数据
      const title = data.title || "无标题";
      const description = data.description || "";
      
      // 提取封面图（Karakeep 将抓到的封面存在 content.imageAssetId 或直接是 imageUrl）
      // 如果获取不到，直接设为空字符串
      let imageUrl = "";
      if (data.content && data.content.imageAssetId) {
          // Karakeep 的图片资源需要转成访问链接
          imageUrl = `https://karakeep.mcck.ccwu.cc/api/assets/${data.content.imageAssetId}`;
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
