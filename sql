-- bookmarks 表：
CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE,
    title TEXT,
    description TEXT,
    image_url TEXT,
    img_file_id TEXT,
    vid_file_id TEXT,
    category_path TEXT DEFAULT '/default',
    is_favorite INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- categories 表
CREATE TABLE IF NOT EXISTS categories (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_path TEXT NOT NULL DEFAULT '/',
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

--  插入默认分类（锁定）
INSERT OR IGNORE INTO categories (path, name, parent_path, is_system)
VALUES ('/default', '默认', '/', 1);

-- 索引（列表查询会用到）
CREATE INDEX IF NOT EXISTS idx_bookmarks_category ON bookmarks(category_path);
CREATE INDEX IF NOT EXISTS idx_bookmarks_status ON bookmarks(status);
CREATE INDEX IF NOT EXISTS idx_bookmarks_favorite ON bookmarks(is_favorite);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_path);









