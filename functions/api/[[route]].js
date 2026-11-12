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

  // 1. 触发抓取
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
      
      if (!res.ok) throw new Error("Karakeep 拒绝请求，请检查 Token");
      const data = await res.json();
      
      return new Response(JSON.stringify({ success: true, bookmarkId: data.id }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  // 2. 轮询并写入 D1
  if (path === '/api/check-status' && request.method === 'GET') {
    try {
      const bookmarkId = url.searchParams.get('id');
      const res = await fetch(`https://karakeep.mcck.ccwu.cc/api/v1/bookmarks/${bookmarkId}`, {
        headers: { 'Authorization': `Bearer ${env.KARAKEEP_TOKEN}` }
      });
      const data = await res.json();

      // 🎯 直接判断真实数据：只要 content 里有 title，就算抓取完成
      if (!data.content || !data.content.title) {
        return new Response(JSON.stringify({ status: 'processing' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const title = data.content.title;
      const description = data.content.description || "";
      let imageUrl = data.content.imageUrl || (data.content.imageAssetId ? `https://karakeep.mcck.ccwu.cc/api/assets/${data.content.imageAssetId}` : "");

      // 写入 D1 (防止重复)
      await env.DB.prepare(
        `INSERT OR REPLACE INTO bookmarks (url, title, description, image_url) VALUES (?, ?, ?, ?)`
      ).bind(data.content.url, title, description, imageUrl).run();

      return new Response(JSON.stringify({ status: 'success' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  // 3. 读取列表
  if (path === '/api/list' && request.method === 'GET') {
    try {
      const { results } = await env.DB.prepare(`SELECT * FROM bookmarks ORDER BY created_at DESC`).all();
      return new Response(JSON.stringify({ success: true, data: results || [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders });
}
